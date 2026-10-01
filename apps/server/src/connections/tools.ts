import { Array as Arr, Effect, Option, Order } from 'effect'
import {
  ActionTarget,
  ConnectionRequestMessage,
  ConnectionTool,
  InvalidRequest,
  ProposedAction,
  ToolOutcome,
  Workspace,
  type FindToolsRequest,
  type OfferConnectionRequest,
  type Person,
  type Service,
  type UseToolRequest,
} from '@vivid/contracts'
import { type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { ActionOutcome, Gate, GateDecision, type GateExposure } from '../approvals/gate.ts'
import { requireThread } from '../threads/access.ts'
import { Executor, ExecutorCallOutcome, ExecutorResumeOutcome } from './executor.ts'
import { callFailure } from './errors.ts'
import { ConnectionStore } from './store.ts'
import type { ConnectionRecord } from './records.ts'

/** Distinct query words prevent repeated tokens from inflating relevance. */
const words = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])

/** Rank plain metadata only; ties preserve provider ordering. */
const rank = <A extends { readonly name: string; readonly description: string }>(
  items: readonly A[],
  query: string,
  limit: number,
): readonly A[] => {
  const queryWords = words(query)
  const scored = items.flatMap((item) => {
    const score = [...words(`${item.name} ${item.description}`)].filter((word) =>
      queryWords.has(word),
    ).length
    return score === 0 ? [] : [{ item, score }]
  })
  return Arr.sortWith(scored, (item) => item.score, Order.flip(Order.Number))
    .slice(0, limit)
    .map(({ item }) => item)
}

/** The account label and provider effect accompany every discoverable tool. */
const projectTools = Effect.fn('Connections.projectTools')(function* (
  store: typeof ConnectionStore.Service,
  row: ConnectionRecord,
) {
  const tools = yield* store.tools(row)
  return tools.flatMap((tool) =>
    row.companyId !== null && tool.effect !== 'read'
      ? []
      : [ConnectionTool.make({ ...tool, connectionId: row.id, account: row.label })],
  )
})

/** Discovery removes shared writes before any tool enters model context. */
export const findTools = Effect.fn('Connections.findTools')(function* (
  actor: Actor,
  request: FindToolsRequest,
) {
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  const groups = yield* Effect.forEach(
    records.filter((row) => row.status === 'ready'),
    (row) => projectTools(store, row),
    { concurrency: 4 },
  )
  const services = yield* store
    .catalog()
    .pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  const unconnected = services.filter(
    (service) => !records.some((row) => row.service === service.id),
  )
  const limit = request.limit === undefined ? 8 : request.limit
  if (!Number.isFinite(limit) || limit < 1)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Tool limit must be a positive number.' }),
    )
  return {
    tools: rank(groups.flat(), request.query, Math.min(25, Math.floor(limit))),
    unconnected: rank(unconnected, request.query, 3),
  }
})

/** Shared Threads expose personal results even when the operation is a read. */
const exposureOf = Effect.fn('Connections.exposure')(function* (
  actor: Actor,
  row: ConnectionRecord,
): Effect.fn.Return<
  GateExposure,
  import('@vivid/contracts').NotFound | import('../database/client.ts').DatabaseInfrastructureError,
  import('../database/client.ts').Database
> {
  if (row.companyId !== null) return 'Ordinary'
  if (Option.isNone(actor.threadId)) return 'Ordinary'
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  return thread.audience === 'private' ? 'Ordinary' : 'PersonalInShared'
})

/** Vivid's gate authorizes execution; provider consent resumes the approved call. */
export const runConnection = Effect.fn('Connections.run')(function* (
  actor: Actor,
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
) {
  const executor = yield* Executor
  const outcome = yield* executor
    .call({ references: row.references, tool: target.tool, input: target.input })
    .pipe(Effect.catch((error) => Effect.succeed(callFailure(error))))
  return yield* ExecutorCallOutcome.match<
    Effect.Effect<
      ToolOutcome,
      | import('@vivid/contracts').NotFound
      | import('@vivid/contracts').Conflict
      | import('../database/client.ts').DatabaseInfrastructureError,
      ConnectionStore
    >
  >(outcome, {
    Completed: ({ value }) => Effect.succeed(ToolOutcome.cases.Completed.make({ output: value })),
    Rejected: ({ message }) => Effect.succeed(ToolOutcome.cases.Rejected.make({ message })),
    OutcomeUnknown: () => Effect.succeed(ToolOutcome.cases.OutcomeUnknown.make({})),
    NotReady: () => markNotReady(actor, row),
    ApprovalRequired: ({ requestId }) =>
      executor.resume({ requestId, accept: true }).pipe(
        Effect.catch(() => Effect.succeed(ExecutorResumeOutcome.cases.OutcomeUnknown.make({}))),
        Effect.map((resumed) =>
          ExecutorResumeOutcome.match<ToolOutcome>(resumed, {
            Completed: ({ value }) => ToolOutcome.cases.Completed.make({ output: value }),
            Denied: () =>
              ToolOutcome.cases.Rejected.make({ message: 'The service declined the action.' }),
            Failed: ({ reason }) => ToolOutcome.cases.Rejected.make({ message: reason }),
            AlreadyConsumed: () => ToolOutcome.cases.OutcomeUnknown.make({}),
            OutcomeUnknown: () => ToolOutcome.cases.OutcomeUnknown.make({}),
          }),
        ),
      ),
  })
})

/** Revoked authorization refreshes screens before Vivid offers reconnection. */
const markNotReady = Effect.fn('Connections.markNotReady')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  yield* (yield* ConnectionStore)
    .notReady(actor, row)
    .pipe(Effect.catchTag('Conflict', () => Effect.void))
  return ToolOutcome.cases.ConnectionNotReady.make({
    service: row.service,
    serviceName: row.serviceName,
  })
})

/** Tool refusals are data; permission and effect come from ownership and provider metadata. */
export const useTool = Effect.fn('Connections.useTool')(function* (
  actor: Actor,
  request: UseToolRequest,
) {
  const store = yield* ConnectionStore
  const found = yield* store.get(actor, request.connectionId).pipe(
    Effect.map(Option.some),
    Effect.catchTag('NotFound', () => Effect.succeed(Option.none())),
  )
  if (Option.isNone(found))
    return ToolOutcome.cases.Rejected.make({ message: 'This Connection is not available to you.' })
  const row = found.value
  if (row.status !== 'ready')
    return ToolOutcome.cases.ConnectionNotReady.make({
      service: row.service,
      serviceName: row.serviceName,
    })
  const tools = yield* store.tools(row).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      ServiceUnavailable: () => Effect.succeed(Option.none()),
      InvalidRequest: () => Effect.succeed(Option.none()),
      Conflict: () => Effect.succeed(Option.none()),
    }),
  )
  if (Option.isNone(tools))
    return ToolOutcome.cases.Rejected.make({ message: 'Connections are unavailable.' })
  const tool = tools.value.find((entry) => entry.name === request.tool)
  if (tool === undefined)
    return ToolOutcome.cases.Rejected.make({
      message: `Tool ${request.tool} is not available on this Connection.`,
    })
  if (row.companyId !== null && tool.effect !== 'read')
    return ToolOutcome.cases.Rejected.make({
      message: 'Shared Connections are read-only. Connect your own account to make this change.',
    })
  const target = ActionTarget.cases.Connection.make({
    connectionId: row.id,
    account: row.label,
    tool: tool.name,
    input: request.input,
  })
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: request.rationale,
    effect: tool.effect,
    target,
  })
  const decision = yield* (yield* Gate).check(actor, action, yield* exposureOf(actor, row))
  return yield* GateDecision.match<ReturnType<typeof runConnection>>(decision, {
    Blocked: ({ rule }) => Effect.succeed(ToolOutcome.cases.Blocked.make({ rule })),
    ApprovalRequired: ({ approval }) =>
      Effect.succeed(
        ToolOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: () => runConnection(actor, row, target),
  })
})

/** Delayed approvals re-read Membership and inventory, preventing removed accounts from executing. */
export const connectionRunner = Effect.fn('Connections.runApproved')(
  function* (input: {
    readonly person: Person
    readonly workspace: Workspace
    readonly target: typeof ActionTarget.cases.Connection.Type
  }) {
    const workspace = yield* workspaceIn(
      input.person.id,
      Workspace.match(input.workspace, {
        Personal: () => Option.none(),
        Company: ({ company }) => Option.some(company.id),
      }),
    )
    const actor: Actor = { person: input.person, workspace, by: 'vivid', threadId: Option.none() }
    const store = yield* ConnectionStore
    const row = yield* store.get(actor, input.target.connectionId)
    if (row.status !== 'ready')
      return ActionOutcome.cases.Failed.make({ reason: 'This Connection needs authorization.' })
    const tool = (yield* store.tools(row)).find((entry) => entry.name === input.target.tool)
    if (tool === undefined || (row.companyId !== null && tool.effect !== 'read'))
      return ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this Connection.',
      })
    return ToolOutcome.match<ActionOutcome>(yield* runConnection(actor, row, input.target), {
      Completed: ({ output }) =>
        ActionOutcome.cases.Succeeded.make({ result: JSON.stringify(output).slice(0, 4000) }),
      Rejected: ({ message }) => ActionOutcome.cases.Failed.make({ reason: message }),
      ConnectionNotReady: () =>
        ActionOutcome.cases.Failed.make({ reason: 'This Connection needs authorization.' }),
      OutcomeUnknown: () => ActionOutcome.cases.Unknown.make({}),
      Blocked: ({ rule }) => ActionOutcome.cases.Failed.make({ reason: rule }),
      ApprovalRequired: () =>
        ActionOutcome.cases.Failed.make({ reason: 'This action requires a new Approval.' }),
    })
  },
  (effect) =>
    effect.pipe(
      Effect.catch(() =>
        Effect.succeed(
          ActionOutcome.cases.Failed.make({
            reason:
              'The Connection is no longer available; check its authorization and your access.',
          }),
        ),
      ),
    ),
)

/** Offers use actual catalog entries and the same ownership rules as discovery. */
export const offerConnection = Effect.fn('Connections.offer')(function* (
  actor: Actor,
  request: OfferConnectionRequest,
) {
  const store = yield* ConnectionStore
  const service = (yield* store.catalog()).find((entry) => entry.id === request.service)
  if (service === undefined)
    return yield* Effect.fail(new InvalidRequest({ message: 'Unknown service.' }))
  const ready = (yield* store.records(actor)).some(
    (row) => row.service === service.id && row.status === 'ready',
  )
  return ConnectionRequestMessage.make({
    kind: 'connection-request',
    service: service.id,
    serviceName: service.name,
    reason: request.reason,
    ready,
  })
})
