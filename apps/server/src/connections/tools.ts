import { Array as Arr, Effect, Option, Order, Schema } from 'effect'
import {
  ActionTarget,
  ConnectionRequestMessage,
  ConnectionTool,
  ConnectionState,
  InvalidRequest,
  NotFound,
  ProposedAction,
  ServiceAuthorization,
  ToolOutcome,
  Workspace,
  type FindToolsRequest,
  type OfferConnectionRequest,
  type Person,
  type Service,
  type UseToolRequest,
} from '@vivid/contracts'
import { requireCompany, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { ActionOutcome, Gate, GateDecision, type GateExposure } from '../approvals/gate.ts'
import { requireThread } from '../threads/access.ts'
import {
  Executor,
  ExecutorCallOutcome,
  ExecutorResourceMissing,
  connectionSetupMessage,
  resourceReason,
  ExecutorResumeOutcome,
} from './executor.ts'
import { executorFailure } from './errors.ts'
import { ConnectionStore } from './store.ts'
import { stateOf, type ConnectionRecord } from './records.ts'

const isResourceMissing = Schema.is(ExecutorResourceMissing)

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
  actor: Actor,
  row: ConnectionRecord,
  account: string,
) {
  const tools = yield* store.tools(actor, row)
  return tools.flatMap((tool) =>
    row.companyId !== null && tool.effect !== 'read'
      ? []
      : [ConnectionTool.make({ ...tool, connectionId: row.id, account })],
  )
})

/** Name all accessible Connections before status/query filtering; creation order fixes duplicate suffixes.
 * Reserve literal labels too so an account actually named “Gmail (2)” cannot collide with a suffix. */
export function namedAccounts(records: readonly ConnectionRecord[]) {
  const ordered = Arr.sort(
    records,
    Order.combine(
      Order.mapInput(Order.Number, (row: ConnectionRecord) => row.createdAt),
      Order.mapInput(Order.String, (row: ConnectionRecord) => row.id),
    ),
  )
  const reserved = new Set(ordered.map((row) => row.label.trim().toLowerCase()))
  const used = new Set<string>()
  return ordered.map((row) => {
    const label = row.label.trim()
    let account = label
    let occurrence = 2
    if (used.has(account.toLowerCase())) {
      do {
        account = `${label} (${occurrence++})`
      } while (used.has(account.toLowerCase()) || reserved.has(account.toLowerCase()))
    }
    used.add(account.toLowerCase())
    return { row, account }
  })
}

/** Discovery removes shared writes before any tool enters model context. */
export const findTools = Effect.fn('Connections.findTools')(function* (
  actor: Actor,
  request: FindToolsRequest,
) {
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  const groups = yield* Effect.forEach(
    namedAccounts(records).filter(({ row }) => row.status === 'ready'),
    ({ row, account }) => projectTools(store, actor, row, account),
    { concurrency: 4 },
  )
  const services = yield* store
    .catalog()
    .pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  const unconnected = services.filter(
    (service) => !records.some((row) => row.service === service.id && row.status === 'ready'),
  )
  const offered = yield* Effect.forEach(
    rank(unconnected, request.query, 3),
    (service) => store.service(service.id),
    { concurrency: 3 },
  ).pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  const limit = request.limit === undefined ? 8 : request.limit
  if (!Number.isFinite(limit) || limit < 1)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Tool limit must be a positive number.' }),
    )
  return {
    tools: rank(groups.flat(), request.query, Math.min(25, Math.floor(limit))),
    unconnected: offered.filter(
      (service) => !ServiceAuthorization.guards.SetupRequired(service.authorization),
    ),
  }
})

/** Resolve the exact pair under the same account naming and effect restrictions as discovery.
 * Ranking and result limits never participate; inaccessible or stale pairs are simply absent. */
export const resolveTool = Effect.fn('Connections.resolveTool')(function* (
  actor: Actor,
  request: { readonly account: string; readonly tool: string },
) {
  const store = yield* ConnectionStore
  const account = namedAccounts(yield* store.records(actor)).find(
    (entry) => entry.account === request.account && entry.row.status === 'ready',
  )
  if (account === undefined) return yield* Effect.fail(new NotFound({ message: 'Tool not found' }))
  const tools = yield* projectTools(store, actor, account.row, account.account)
  const tool = tools.find((entry) => entry.name === request.tool)
  if (tool === undefined) return yield* Effect.fail(new NotFound({ message: 'Tool not found' }))
  return tool
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
    .pipe(
      Effect.mapError((error) => (isResourceMissing(error) ? error : executorFailure(error))),
      Effect.catchTag(
        'ExecutorResourceMissing',
        Effect.fn('Connections.missing')(function* ({ resource }) {
          const reason = resourceReason(resource)
          yield* (yield* ConnectionStore).failed(actor, row, reason)
          return ExecutorCallOutcome.cases.Rejected.make({ message: reason })
        }),
      ),
    )
  return yield* ExecutorCallOutcome.match<
    Effect.Effect<
      ToolOutcome,
      | import('@vivid/contracts').NotFound
      | ReturnType<typeof executorFailure>
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
      executor.resume({ references: row.references, requestId, accept: true }).pipe(
        Effect.mapError(executorFailure),
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
  const state = yield* stateOf(row)
  if (ConnectionState.guards.Failed(state))
    return ToolOutcome.cases.Rejected.make({ message: state.reason })
  if (ConnectionState.guards.NeedsAuthorization(state))
    return ToolOutcome.cases.ConnectionNotReady.make({
      service: row.service,
      serviceName: row.serviceName,
    })
  const tools = yield* store.tools(actor, row).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
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

/** Only a missing record or revoked permission proves that this delayed action did not run. */
const unavailableAction = () =>
  Effect.succeed(
    ActionOutcome.cases.Failed.make({
      reason: 'The Connection is no longer available; check its authorization and your access.',
    }),
  )

/** Delayed approvals re-read access. Infrastructure faults remain uncertain, including faults
 * while recording a post-dispatch authorization loss; they never invent a permanent refusal. */
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
    // An Approval in a Company cannot survive removal of its acting Person's Membership.
    if (Workspace.guards.Company(input.workspace)) yield* requireCompany(workspace)
    const actor: Actor = { person: input.person, workspace, by: 'vivid', threadId: Option.none() }
    const store = yield* ConnectionStore
    const row = yield* store.get(actor, input.target.connectionId)
    const state = yield* stateOf(row)
    if (ConnectionState.guards.Failed(state))
      return ActionOutcome.cases.Failed.make({ reason: state.reason })
    if (ConnectionState.guards.NeedsAuthorization(state))
      return ActionOutcome.cases.Failed.make({ reason: 'This Connection needs authorization.' })
    // This read precedes dispatch, so losing discovery is a failed, retryable action.
    const discovered = yield* store.tools(actor, row).pipe(
      Effect.catchTag('ServiceUnavailable', () =>
        Effect.fail(
          new InvalidRequest({
            message: 'Tool discovery failed before the action was sent. Retry discovery.',
          }),
        ),
      ),
    )
    const tool = discovered.find((entry) => entry.name === input.target.tool)
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
      Effect.catchTags({
        NotFound: unavailableAction,
        Forbidden: unavailableAction,
        ServiceUnavailable: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseUnavailable: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseConstraintViolation: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseFailure: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        Conflict: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        InvalidRequest: ({ message }) =>
          Effect.succeed(ActionOutcome.cases.Failed.make({ reason: message })),
      }),
    ),
)

/** Offers use actual catalog entries and the same ownership rules as discovery. */
export const offerConnection = Effect.fn('Connections.offer')(function* (
  actor: Actor,
  request: OfferConnectionRequest,
) {
  const store = yield* ConnectionStore
  const service = yield* store.service(request.service)
  if (ServiceAuthorization.guards.SetupRequired(service.authorization))
    return yield* Effect.fail(new InvalidRequest({ message: connectionSetupMessage }))
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
