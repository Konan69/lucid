import { Array as Arr, Clock, Duration, Effect, Option, Order, Schema } from 'effect'
import {
  ActionTarget,
  ConnectionRequestMessage,
  ConnectionTool,
  DiscoveredTool,
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
import {
  actionOrigin,
  ActionOutcome,
  Gate,
  GateDecision,
  type GateExposure,
} from '../approvals/gate.ts'
import { requireThread } from '../threads/access.ts'
import {
  Executor,
  ExecutorCallOutcome,
  ExecutorTool,
  ExecutorResourceMissing,
  connectionSetupMessage,
  resourceReason,
} from './executor.ts'
import { callableTool, discoveredTool } from '../code/signatures.ts'
import { executorFailure } from './errors.ts'
import { ConnectionStore } from './store.ts'
import { decisionConfigured, isDecisionNonEvent } from '../decisions/model.ts'
import { relevantTools, relevantToolsWithin, RELEVANCE_BUDGET } from './relevance.ts'
import { ToolEffects } from './effects.ts'
import { stateOf, type ConnectionRecord } from './records.ts'

/** Provider schemas stay on this server projection; discovery publishes only rendered signatures. */
const NamedTool = ExecutorTool.pipe(
  Schema.fieldsAssign({
    connectionId: ConnectionTool.fields.connectionId,
    account: ConnectionTool.fields.account,
    serviceName: Schema.String,
  }),
)

const isResourceMissing = Schema.is(ExecutorResourceMissing)

/** Distinct query words prevent repeated tokens from inflating relevance. */
const words = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])

/** Tool capability words outrank identity words, so broad account labels cannot crowd a
 * specific operation out of the bound. Stable ties retain provider order. */
const rank = <A>(
  items: readonly A[],
  query: string,
  limit: number,
  texts: (item: A) => { readonly own: string; readonly identity: string },
): readonly A[] => {
  const queryWords = words(query)
  const score = (text: string) => [...words(text)].filter((word) => queryWords.has(word)).length
  const scored = items.flatMap((item) => {
    const text = texts(item)
    const own = score(text.own)
    const identity = score(text.identity)
    return own + identity === 0 ? [] : [{ item, own, identity }]
  })
  return Arr.sort(
    scored,
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (entry: (typeof scored)[number]) => entry.own),
      Order.mapInput(Order.flip(Order.Number), (entry: (typeof scored)[number]) => entry.identity),
    ),
  )
    .slice(0, limit)
    .map(({ item }) => item)
}

/** Mandatory metadata still loads after the optional deadline. Only classification is
 * interrupted: unanswered tools keep Executor's effect for this call. rc.116 Cache.get
 * removes interrupted entries and interrupts a lookup when its final waiter leaves, so
 * cancellation creates neither an answer nor a one-minute failure entry. Completed tools
 * retain their real cache receipts; shared writes are withheld before entering model context. */
const projectTools = Effect.fn('Connections.projectTools')(function* (
  store: typeof ConnectionStore.Service,
  actor: Actor,
  { row, account }: { readonly row: ConnectionRecord; readonly account: string },
  started: number,
) {
  const tools = yield* store.tools(actor, row)
  const classified = yield* classifyTools(row, tools, started)
  return classified.flatMap((tool) =>
    row.companyId !== null && tool.effect !== 'read'
      ? []
      : [NamedTool.make({ ...tool, connectionId: row.id, account, serviceName: row.serviceName })],
  )
})

/** Per-tool timers preserve already-answered siblings when a catalog spans batches.
 * All timers share findTools' deadline; concurrent misses still reach the grouped resolver.
 * Deadline cancellation is optional-work exhaustion, not provider-outage evidence. */
const classifyTools = Effect.fn('Connections.classifyTools')(function* (
  row: ConnectionRecord,
  tools: readonly (typeof ExecutorTool.Type)[],
  started: number,
) {
  const remaining = FIND_TOOLS_BUDGET_MILLIS - ((yield* Clock.currentTimeMillis) - started)
  if (remaining <= 0) return tools
  const effects = yield* ToolEffects
  return yield* Effect.forEach(
    tools,
    Effect.fn('Connections.discoveryEffect')(function* (tool) {
      const effect = yield* effects
        .classify({ serviceId: row.service, service: row.serviceName, tool })
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(remaining),
            orElse: () => Effect.succeed(tool.effect),
          }),
        )
      return ExecutorTool.make({ ...tool, effect })
    }),
    { concurrency: 'unbounded' },
  )
})

/** Execution and label resolution classify only the requested metadata. */
const classifyTool = Effect.fn('Connections.classifyTool')(function* (
  row: ConnectionRecord,
  tool: typeof ExecutorTool.Type,
) {
  const effect = yield* (yield* ToolEffects).classify({
    serviceId: row.service,
    service: row.serviceName,
    tool,
  })
  return ExecutorTool.make({ ...tool, effect })
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

/** Catalog reads only enrich Integration offers and do not depend on semantic ranking.
 * Keeping this branch separate lets both optional reads overlap while retaining the existing
 * ServiceUnavailable baseline and ready-Integration exclusion. */
const offeredServices = Effect.fn('Connections.offeredServices')(function* (
  store: typeof ConnectionStore.Service,
  records: readonly ConnectionRecord[],
  query: string,
) {
  const services = yield* store
    .catalog()
    .pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  const unconnected = services.filter(
    (service) => !records.some((row) => row.service === service.id && row.status === 'ready'),
  )
  return yield* Effect.forEach(
    rank(unconnected, query, 3, (service) => ({
      own: `${service.name} ${service.description}`,
      identity: '',
    })),
    (service) => store.service(service.id),
    { concurrency: 3 },
  ).pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
})

/**
 * The lexical candidates in the order discovery returns them. Zero or one candidate has nothing
 * to order, and switched-off decisions return at once; neither is a degraded answer worth a
 * warning. It never fails: when relevance cannot be judged the lexical order stands.
 */
const orderTools = Effect.fn('Connections.orderTools')(function* <
  A extends Parameters<typeof relevantTools>[1][number],
>(query: string, lexical: ReadonlyArray<A>, started: number) {
  if (lexical.length < 2 || !(yield* decisionConfigured)) return lexical
  const remaining = FIND_TOOLS_BUDGET_MILLIS - ((yield* Clock.currentTimeMillis) - started)
  if (remaining < RELEVANCE_MINIMUM_MILLIS) return lexical
  const budget = Duration.min(
    Duration.millis(remaining),
    Duration.fromInputUnsafe(RELEVANCE_BUDGET),
  )
  return yield* relevantToolsWithin(query, lexical, budget).pipe(
    Effect.map((result) => result.ordered),
    Effect.catch((error) =>
      isDecisionNonEvent(error)
        ? Effect.succeed(lexical)
        : Effect.logWarning('Tool relevance unavailable', {
            tag: error._tag,
            reason: error.reason,
          }).pipe(Effect.as(lexical)),
    ),
  )
})

/** Gateway, jev-latest, 4 Oct 2026: effect/relevance warm medians total 1589.5ms. A shared
 * 2000ms deadline leaves 410.5ms typical headroom and caps sequential optional stages together;
 * every classification group and relevance share it, including queued Integrations.
 * Mandatory store reads retain their normal baseline semantics. */
const FIND_TOOLS_BUDGET_MILLIS = 2000
/** Gateway twenty-question warm medians measured 650–820ms. Below 850ms, relevance
 * lacks even typical headroom: skip it silently instead of manufacturing timeout evidence
 * for the outage gate. This is optional ordering, never evidence about provider health. */
const RELEVANCE_MINIMUM_MILLIS = 850

/** Discovery removes shared writes before any tool enters model context. */
export const findTools = Effect.fn('Connections.findTools')(function* (
  actor: Actor,
  request: FindToolsRequest,
) {
  const store = yield* ConnectionStore
  const started = yield* Clock.currentTimeMillis
  const records = yield* store.records(actor)
  const groups = yield* Effect.forEach(
    namedAccounts(records).filter(({ row }) => row.status === 'ready'),
    (named) => projectTools(store, actor, named, started),
    { concurrency: 4 },
  )
  const limit = request.limit === undefined ? 8 : request.limit
  if (!Number.isFinite(limit) || limit < 1)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Tool limit must be a positive number.' }),
    )
  const available = groups.flat().filter(callableTool)
  const lexical = rank(available, request.query, available.length, (tool) => ({
    own: `${tool.name} ${tool.description}`,
    identity: `${tool.serviceName} ${tool.account}`,
  }))
  const [ordered, offered] = yield* Effect.all(
    [orderTools(request.query, lexical, started), offeredServices(store, records, request.query)],
    { concurrency: 2 },
  )
  const limited = ordered.slice(0, Math.min(25, Math.floor(limit)))
  // One slot belongs to the promoted winner. With larger limits, reserve the final slot
  // for the strongest lexical match only when semantic promotion would otherwise evict it.
  const selected = Option.match(Arr.head(lexical), {
    onNone: () => limited,
    onSome: (first) =>
      limited.length === 1 || limited.includes(first) ? limited : [...limited.slice(0, -1), first],
  })
  return {
    tools: yield* Effect.forEach(
      selected,
      Effect.fn('Connections.discoveredTool')(function* (tool) {
        return DiscoveredTool.make({
          connectionId: tool.connectionId,
          account: tool.account,
          name: tool.name,
          description: tool.description,
          effect: tool.effect,
          ...(yield* discoveredTool(tool)),
        })
      }),
    ),
    unconnected: offered.filter(
      (service) => !ServiceAuthorization.guards.SetupRequired(service.authorization),
    ),
  }
})

/** Resolve labels without case/edge-space differences; provider tool identifiers remain exact.
 * Ranking and result limits never participate; inaccessible or stale pairs are simply absent. */
export const resolveTool = Effect.fn('Connections.resolveTool')(function* (
  actor: Actor,
  request: { readonly account: string; readonly tool: string },
) {
  const store = yield* ConnectionStore
  const requestedAccount = request.account.trim().toLowerCase()
  const account = namedAccounts(yield* store.records(actor)).find(
    (entry) => entry.account.toLowerCase() === requestedAccount && entry.row.status === 'ready',
  )
  if (account === undefined) return yield* Effect.fail(new NotFound({ message: 'Tool not found' }))
  const tools = yield* store.tools(actor, account.row)
  const requested = tools.find((entry) => entry.name === request.tool)
  if (requested === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Tool not found' }))
  const tool = yield* classifyTool(account.row, requested)
  if (account.row.companyId !== null && tool.effect !== 'read')
    return yield* Effect.fail(new NotFound({ message: 'Tool not found' }))
  return NamedTool.make({
    ...tool,
    connectionId: account.row.id,
    account: account.account,
    serviceName: account.row.serviceName,
  })
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

/** Vivid's gate authorizes execution; unsupported provider approval fails at the adapter. */
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
    Rejected: ({ message, problems }) =>
      Effect.succeed(ToolOutcome.cases.Rejected.make({ message, problems })),
    OutcomeUnknown: () => Effect.succeed(ToolOutcome.cases.OutcomeUnknown.make({})),
    NotReady: () => markNotReady(actor, row),
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
    return ToolOutcome.cases.Rejected.make({ message: 'This integration is not available to you.' })
  const row = found.value
  const state = yield* stateOf(row)
  const refusal = ConnectionState.match<Option.Option<ToolOutcome>>(state, {
    Failed: ({ reason }) => Option.some(ToolOutcome.cases.Rejected.make({ message: reason })),
    NeedsAuthorization: () =>
      Option.some(
        ToolOutcome.cases.ConnectionNotReady.make({
          service: row.service,
          serviceName: row.serviceName,
        }),
      ),
    Ready: () => Option.none(),
  })
  if (Option.isSome(refusal)) return refusal.value
  const tools = yield* store.tools(actor, row).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      InvalidRequest: () => Effect.succeed(Option.none()),
      Conflict: () => Effect.succeed(Option.none()),
    }),
  )
  if (Option.isNone(tools))
    return ToolOutcome.cases.Rejected.make({ message: 'Integrations are unavailable.' })
  const requested = tools.value.find((entry) => entry.name === request.tool)
  if (requested === undefined)
    return ToolOutcome.cases.Rejected.make({
      message: `Tool ${request.tool} is not available on this integration.`,
    })
  const tool = yield* classifyTool(row, requested)
  if (row.companyId !== null && tool.effect !== 'read')
    return ToolOutcome.cases.Rejected.make({
      message: 'Shared integrations are read-only. Connect your own account to make this change.',
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
  const decision = yield* (yield* Gate).check(
    { ...actor, origin: yield* actionOrigin(actor) },
    action,
    yield* exposureOf(actor, row),
  )
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
      reason: 'The integration is no longer available; check its authorization and your access.',
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
    const refusal = ConnectionState.match<Option.Option<ActionOutcome>>(state, {
      Failed: ({ reason }) => Option.some(ActionOutcome.cases.Failed.make({ reason })),
      NeedsAuthorization: () =>
        Option.some(
          ActionOutcome.cases.Failed.make({ reason: 'This integration needs authorization.' }),
        ),
      Ready: () => Option.none(),
    })
    if (Option.isSome(refusal)) return refusal.value
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
    const requested = discovered.find((entry) => entry.name === input.target.tool)
    if (requested === undefined)
      return ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this integration.',
      })
    const tool = yield* classifyTool(row, requested)
    if (row.companyId !== null && tool.effect !== 'read')
      return ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this integration.',
      })
    return ToolOutcome.match<ActionOutcome>(yield* runConnection(actor, row, input.target), {
      Completed: ({ output }) =>
        ActionOutcome.cases.Succeeded.make({ result: JSON.stringify(output).slice(0, 4000) }),
      Rejected: ({ message }) => ActionOutcome.cases.Failed.make({ reason: message }),
      ConnectionNotReady: () =>
        ActionOutcome.cases.Failed.make({ reason: 'This integration needs authorization.' }),
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
