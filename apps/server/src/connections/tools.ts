import { Array as Arr, Clock, Duration, Effect, Option, Order, Result, Schema } from 'effect'
import {
  ActionTarget,
  AnotherAccountMessage,
  ConnectionRequestMessage,
  ConnectionTool,
  DiscoveredTool,
  ConnectionState,
  InvalidRequest,
  NotFound,
  ProposedAction,
  ServiceAuthorization,
  ToolOutcome,
  DisplayApprovalUnsupported,
  Workspace,
  type FindToolsRequest,
  type OfferConnectionRequest,
  type Person,
  type Service,
  type UseDisplayToolRequest,
  type UseToolRequest,
  DisplayCallPolicy,
  displayCallPolicy,
  displayCallRefusal,
} from '@vivid/contracts'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { requireCompany, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { ActionOutcome, Gate, GateDecision, type GateExposure } from '../approvals/gate.ts'
import { requireThread } from '../threads/access.ts'
import {
  Executor,
  ExecutorCallOutcome,
  ExecutorTool,
  ExecutorResourceMissing,
  ExecutorApprovalUnsupported,
  connectionSetupMessage,
  resourceReason,
} from './executor.ts'
import { callableTool, discoveredTool } from '../code/signatures.ts'
import { executorFailure } from './errors.ts'
import { ConnectionStore, ToolDiscovery } from './store.ts'
import { decisionConfigured, isDecisionNonEvent } from '../decisions/model.ts'
import { relevantTools, relevantToolsWithin, RELEVANCE_BUDGET } from './relevance.ts'
import { ToolEffects } from './effects.ts'
import { stateOf, type ConnectionRecord } from './records.ts'
import { namedAccounts } from './names.ts'

/** Provider schemas stay on this server projection; discovery publishes only rendered signatures. */
const NamedTool = ExecutorTool.pipe(
  Schema.fieldsAssign({
    connectionId: ConnectionTool.fields.connectionId,
    account: ConnectionTool.fields.account,
    serviceName: Schema.String,
  }),
)

const isResourceMissing = Schema.is(ExecutorResourceMissing)
const isApprovalUnsupported = Schema.is(ExecutorApprovalUnsupported)

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

/** All mandatory catalog reads finish before the shared optional-work clock starts.
 * Projection keeps Executor's effect when classification exceeds that deadline;
 * shared writes are withheld before tools enter model context. */
const projectTools = Effect.fn('Connections.projectTools')(function* (
  {
    row,
    account,
    tools,
  }: {
    readonly row: ConnectionRecord
    readonly account: string
    readonly tools: readonly (typeof ExecutorTool.Type)[]
  },
  started: number,
) {
  const classified = yield* classifyTools(row, tools, started)
  return classified.flatMap((tool) =>
    row.companyId !== null && tool.effect !== 'read'
      ? []
      : [NamedTool.make({ ...tool, connectionId: row.id, account, serviceName: row.serviceName })],
  )
})

/** Per-tool timers preserve already-answered siblings when a catalog spans batches.
 * All timers share findTools' deadline; concurrent misses still reach the grouped resolver.
 * Deadline cancellation stops only this caller's wait. ToolEffects keeps bounded
 * lookup work in its Layer scope so later discovery can reuse the completed answer.
 * If that lookup later fails or the Layer closes, its failed exit lives for one
 * minute; deliberate absence and shared backoff exits have zero TTL. */
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

/** Catalog reads only enrich Integration offers and do not depend on semantic ranking.
 * Keeping this branch separate lets both optional reads overlap while retaining the existing
 * ServiceUnavailable baseline.
 *
 * A service is offered on one of two lists. One with no ready account is `unconnected`: Vivid can
 * offer it. One the Person already has a ready account on is `connected`: Vivid cannot offer it
 * again as if it were missing, and can ask for one more account on it. Each list is the best
 * three for the query, ranked on its own, so a connected service never takes an offer's place.
 * Only an offer is inspected for whether this Vivid is set up for it; a connected service was
 * set up when its account was added, and `offerConnection` inspects it again before any card. */
const offeredServices = Effect.fn('Connections.offeredServices')(function* (
  store: typeof ConnectionStore.Service,
  records: readonly ConnectionRecord[],
  query: string,
) {
  const services = yield* store
    .catalog()
    .pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  const has = (service: Service) =>
    records.some((row) => row.service === service.id && row.status === 'ready')
  const best = (candidates: readonly Service[]) =>
    rank(candidates, query, 3, (service) => ({
      own: `${service.name} ${service.description}`,
      identity: '',
    }))
  const unconnected = yield* Effect.forEach(
    best(services.filter((service) => !has(service))),
    (service) => store.service(service.id),
    { concurrency: 3 },
  ).pipe(Effect.catchTag('ServiceUnavailable', () => Effect.succeed<readonly Service[]>([])))
  return { unconnected, connected: best(services.filter(has)) }
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
/** Gateway, jev-latest, 4 Oct 2026: the earlier relevance warm maximum was
 * 1389ms; round-five's first cohort measured 691ms. 1800ms retains 411ms (30%)
 * above the larger observed maximum. Shorter remainders skip optional ordering
 * silently; timeout evidence is separately calibrated by the decision gate. */
const RELEVANCE_MINIMUM_MILLIS = 1800

/** Discovery removes shared writes before any tool enters model context. */
export const findTools = Effect.fn('Connections.findTools')(function* (
  actor: Actor,
  request: FindToolsRequest,
) {
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  const catalogs = yield* Effect.forEach(
    namedAccounts(records).filter(({ row }) => row.status === 'ready'),
    Effect.fn('Connections.loadDiscoveryTools')(function* (named) {
      // One account that cannot list its tools (its service refused, its listing timed out) is
      // that account's trouble: the Person's other Integrations still answer. Until 26 October
      // 2026 one such account failed every find_tools for all of them.
      const tools = yield* store.tools(actor, named.row).pipe(
        Effect.map((discovery) =>
          ToolDiscovery.match(discovery, {
            Ready: ({ tools: catalog }) => catalog,
            NeedsAuthorization: () => [],
            Failed: () => [],
          }),
        ),
        Effect.catchTag('InvalidRequest', () =>
          Effect.logWarning('Integration tools unavailable', {
            service: named.row.service,
          }).pipe(Effect.as([])),
        ),
      )
      return { ...named, tools }
    }),
    { concurrency: 4 },
  )
  const started = yield* Clock.currentTimeMillis
  const groups = yield* Effect.forEach(catalogs, (catalog) => projectTools(catalog, started), {
    concurrency: 4,
  })
  const limit = request.limit === undefined ? 8 : request.limit
  if (!Number.isFinite(limit) || limit < 1)
    return yield* new InvalidRequest({ message: 'Tool limit must be a positive number.' })
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
    unconnected: offered.unconnected.filter(
      (service) => !ServiceAuthorization.guards.SetupRequired(service.authorization),
    ),
    connected: offered.connected,
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
  if (account === undefined) return yield* new NotFound({ message: 'Tool not found' })
  const discovery = yield* store.tools(actor, account.row)
  const tools = ToolDiscovery.match(discovery, {
    Ready: ({ tools: catalog }) => catalog,
    NeedsAuthorization: () => [],
    Failed: () => [],
    NeedsAuthorization: () => [],
  })
  const requested = tools.find((entry) => entry.name === request.tool)
  if (requested === undefined) return yield* new NotFound({ message: 'Tool not found' })
  const tool = yield* classifyTool(account.row, requested)
  if (account.row.companyId !== null && tool.effect !== 'read')
    return yield* new NotFound({ message: 'Tool not found' })
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
export const runConnection = Effect.fn('Connections.run')(
  function* (
    actor: Actor,
    row: ConnectionRecord,
    target: typeof ActionTarget.cases.Connection.Type,
  ) {
    const executor = yield* Executor
    const outcome = yield* executor
      .call({ references: row.references, tool: target.tool, input: target.input })
      .pipe(
        Effect.mapError((error) =>
          isResourceMissing(error) || isApprovalUnsupported(error) ? error : executorFailure(error),
        ),
      )
    return yield* ExecutorCallOutcome.match<
      Effect.Effect<
        ToolOutcome,
        | import('@vivid/contracts').NotFound
        | ReturnType<typeof executorFailure>
        | ExecutorApprovalUnsupported
        | import('@vivid/contracts').Conflict
        | import('../database/client.ts').DatabaseInfrastructureError,
        ConnectionStore
      >
    >(outcome, {
      Completed: ({ value }) => Effect.succeed(ToolOutcome.cases.Completed.make({ output: value })),
      Rejected: Effect.fnUntraced(function* ({ message, problems }) {
        // The service answer becomes a Tool rejection here; its private message is never recorded.
        yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'ServiceRejected' }))
        return ToolOutcome.cases.Rejected.make({ message, problems })
      }),
      OutcomeUnknown: () => Effect.succeed(ToolOutcome.cases.OutcomeUnknown.make({})),
      NotReady: () => markNotReady(actor, row),
    })
  },
  (effect, actor, row) =>
    effect.pipe(
      Effect.catchTag(
        'ExecutorResourceMissing',
        Effect.fn('Connections.missing')(function* ({ resource }) {
          const reason = resourceReason(resource)
          yield* (yield* ConnectionStore).failed(actor, row, reason)
          // Vivid just marked the Integration failed; no service Rejected answer exists to count.
          yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationFailed' }))
          return ToolOutcome.cases.Rejected.make({ message: reason })
        }),
      ),
    ),
)

/** Revoked authorization refreshes screens before Vivid offers reconnection. */
const markNotReady = Effect.fn('Connections.markNotReady')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  yield* (yield* ConnectionStore)
    .notReady(actor, row)
    .pipe(Effect.catchTag('Conflict', () => Effect.void))
  // Revoked authorization decides NotReady after updating the Integration's durable state.
  yield* recordRefusal(Refusal.cases.IntegrationNotReady.make({ service: row.service }))
  return ToolOutcome.cases.ConnectionNotReady.make({
    service: row.service,
    serviceName: row.serviceName,
  })
})

/** Admission facts stay separate from caller receipts: approved actions retain their original
 * outcome and prose while direct tool calls retain theirs (tools.ts at 9f0eda42). */
const ToolAdmissionRefusal = Schema.TaggedUnion({
  IntegrationUnavailable: {},
  IntegrationFailed: { reason: Schema.String },
  NeedsAuthorization: {
    service: ToolOutcome.cases.ConnectionNotReady.fields.service,
    serviceName: Schema.String,
  },
  DiscoveryInvalid: { message: Schema.String },
  DiscoveryConflict: {},
  DiscoveryFailed: { tool: Schema.String },
  ToolUnknown: { tool: Schema.String },
  SharedReadOnly: {},
})
type ToolAdmissionRefusal = typeof ToolAdmissionRefusal.Type

/** Direct callers keep the same Tool receipts, including the generic discovery failure text. */
const toolAdmissionOutcome = (decision: ToolAdmissionRefusal) =>
  ToolAdmissionRefusal.match<ToolOutcome>(decision, {
    IntegrationUnavailable: () =>
      ToolOutcome.cases.Rejected.make({ message: 'This integration is not available to you.' }),
    IntegrationFailed: ({ reason }) => ToolOutcome.cases.Rejected.make({ message: reason }),
    NeedsAuthorization: ({ service, serviceName }) =>
      ToolOutcome.cases.ConnectionNotReady.make({ service, serviceName }),
    DiscoveryInvalid: () =>
      ToolOutcome.cases.Rejected.make({ message: 'Integrations are unavailable.' }),
    DiscoveryConflict: () =>
      ToolOutcome.cases.Rejected.make({ message: 'Integrations are unavailable.' }),
    DiscoveryFailed: ({ tool }) =>
      ToolOutcome.cases.Rejected.make({
        message: `Tool ${tool} is not available on this integration.`,
      }),
    ToolUnknown: ({ tool }) =>
      ToolOutcome.cases.Rejected.make({
        message: `Tool ${tool} is not available on this integration.`,
      }),
    SharedReadOnly: () =>
      ToolOutcome.cases.Rejected.make({
        message: 'Shared integrations are read-only. Connect your own account to make this change.',
      }),
  })

/** Approved callers preserve uncertainty on discovery conflict and their original reason texts. */
const approvedAdmissionOutcome = (decision: ToolAdmissionRefusal) =>
  ToolAdmissionRefusal.match<ActionOutcome>(decision, {
    IntegrationUnavailable: () =>
      ActionOutcome.cases.Failed.make({ reason: unavailableActionReason }),
    IntegrationFailed: ({ reason }) => ActionOutcome.cases.Failed.make({ reason }),
    NeedsAuthorization: () =>
      ActionOutcome.cases.Failed.make({ reason: 'This integration needs authorization.' }),
    DiscoveryInvalid: ({ message }) => ActionOutcome.cases.Failed.make({ reason: message }),
    DiscoveryConflict: () => ActionOutcome.cases.Unknown.make({}),
    DiscoveryFailed: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this integration.',
      }),
    ToolUnknown: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this integration.',
      }),
    SharedReadOnly: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'This tool is no longer available on this integration.',
      }),
  })

/** Direct and approved calls share one admission decision, recorded once before dispatch. */
const prepareTool = Effect.fn('Connections.prepareTool')(function* (
  actor: Actor,
  request: Pick<UseToolRequest, 'connectionId' | 'tool'>,
) {
  const store = yield* ConnectionStore
  const found = yield* store.get(actor, request.connectionId).pipe(
    Effect.asSome,
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  if (Option.isNone(found)) {
    // An unavailable scoped record is a Tool refusal; no Integration identity is invented.
    yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return Result.fail(ToolAdmissionRefusal.cases.IntegrationUnavailable.make({}))
  }
  const row = found.value
  const state = yield* stateOf(row)
  const refusal = yield* ConnectionState.match<Effect.Effect<Option.Option<ToolAdmissionRefusal>>>(
    state,
    {
      Failed: Effect.fnUntraced(function* ({ reason }) {
        // The known failed Integration prevents this call; the failure's prose stays in the result.
        yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationFailed' }))
        return Option.some(ToolAdmissionRefusal.cases.IntegrationFailed.make({ reason }))
      }),
      NeedsAuthorization: Effect.fnUntraced(function* () {
        // This call is declined from current Integration state, without attempting the service.
        yield* recordRefusal(Refusal.cases.IntegrationNotReady.make({ service: row.service }))
        return Option.some(
          ToolAdmissionRefusal.cases.NeedsAuthorization.make({
            service: row.service,
            serviceName: row.serviceName,
          }),
        )
      }),
      Ready: () => Effect.succeedNone,
    },
  )
  if (Option.isSome(refusal)) return Result.fail(refusal.value)
  const tools: Result.Result<typeof ToolDiscovery.Type, ToolAdmissionRefusal> = yield* store
    .tools(actor, row)
    .pipe(
      Effect.map(Result.succeed),
      Effect.catchTags({
        InvalidRequest: ({ message }) =>
          Effect.succeed(
            Result.fail(ToolAdmissionRefusal.cases.DiscoveryInvalid.make({ message })),
          ),
        Conflict: () =>
          Effect.succeed(Result.fail(ToolAdmissionRefusal.cases.DiscoveryConflict.make({}))),
      }),
    )
  if (Result.isFailure(tools)) {
    // An invalid discovery is a decision for both callers. A conflict is not decided here: the
    // code path turns it into a rejection and counts it, while the approved path reports the
    // action as Unknown, and an action whose result is uncertain was not refused.
    if (ToolAdmissionRefusal.guards.DiscoveryInvalid(tools.failure))
      yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return Result.fail(tools.failure)
  }
  // Discovery persisted what it found: a lapsed sign-in or a lost resource declines the call as
  // from that state, counted once here; a ready catalog goes on to the requested tool.
  const catalog = yield* ToolDiscovery.match<
    Effect.Effect<Result.Result<readonly (typeof ExecutorTool.Type)[], ToolAdmissionRefusal>>
  >(tools.success, {
    Ready: ({ tools: ready }) => Effect.succeed(Result.succeed(ready)),
    NeedsAuthorization: Effect.fnUntraced(function* () {
      yield* recordRefusal(Refusal.cases.IntegrationNotReady.make({ service: row.service }))
      return Result.fail(
        ToolAdmissionRefusal.cases.NeedsAuthorization.make({
          service: row.service,
          serviceName: row.serviceName,
        }),
      )
    }),
    Failed: Effect.fnUntraced(function* () {
      yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationFailed' }))
      return Result.fail(ToolAdmissionRefusal.cases.DiscoveryFailed.make({ tool: request.tool }))
    }),
  })
  if (Result.isFailure(catalog)) return Result.fail(catalog.failure)
  const requested = catalog.success.find((entry) => entry.name === request.tool)
  if (requested === undefined) {
    // The tool name is Person content; count only the closed missing-capability reason.
    yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'ToolUnknown' }))
    return Result.fail(ToolAdmissionRefusal.cases.ToolUnknown.make({ tool: request.tool }))
  }
  const tool = yield* classifyTool(row, requested)
  if (row.companyId !== null && tool.effect !== 'read') {
    // Shared read-only policy rejects before the Gate; this is a distinct Tool decision.
    yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'SharedReadOnly' }))
    return Result.fail(ToolAdmissionRefusal.cases.SharedReadOnly.make({}))
  }
  return Result.succeed({ row, tool })
})

/** Tool refusals are data; permission and effect come from ownership and provider metadata. */
const useToolAs = Effect.fn('Connections.useTool')(function* (
  actor: Actor,
  request: UseToolRequest,
  policy: DisplayCallPolicy,
) {
  const prepared = yield* prepareTool(actor, request)
  if (Result.isFailure(prepared)) {
    // The one admission refusal `prepareTool` leaves to its caller: here a discovery conflict is
    // a rejection the program reads, so it is counted here and nowhere else.
    if (ToolAdmissionRefusal.guards.DiscoveryConflict(prepared.failure))
      yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return toolAdmissionOutcome(prepared.failure)
  }
  const { row, tool } = prepared.success
  // Discovery may change after name resolution. Recheck at the last admission before the Gate.
  const refusal = displayCallRefusal(policy, tool.effect)
  if (Option.isSome(refusal)) {
    yield* recordRefusal(Refusal.cases.CallRefused.make({ call: 'use_tool' }))
    return ToolOutcome.cases.Rejected.make({
      message: refusal.value,
    })
  }
  // An Approval names the account as discovery named it to Vivid, so the Person is asked about
  // "Gmail (Work)" and never about a bare "Gmail" that could be either of two.
  const named = namedAccounts(yield* (yield* ConnectionStore).records(actor)).find(
    (entry) => entry.row.id === row.id,
  )
  if (named === undefined) {
    // Removed between admission and here: there is no account left to name or to act through.
    yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return toolAdmissionOutcome(ToolAdmissionRefusal.cases.IntegrationUnavailable.make({}))
  }
  const target = ActionTarget.cases.Connection.make({
    connectionId: row.id,
    account: named.account,
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
  }).pipe(
    Effect.catchTag('ExecutorApprovalUnsupported', (error) => Effect.fail(executorFailure(error))),
  )
})

/** Vivid's regular calls retain their existing Gate policy. */
export const useTool = (actor: Actor, request: UseToolRequest) =>
  useToolAs(actor, request, DisplayCallPolicy.cases.Press.make({}))

/** Automatic display programs require a read effect at final admission, even after rediscovery. */
export const useQueryTool = (actor: Actor, request: UseToolRequest) =>
  useToolAs(actor, request, DisplayCallPolicy.cases.Draw.make({}))

/**
 * A display's own call into one of the Person's Integrations (OpenUI's `Query` and `Mutation`,
 * `apps/web/src/parts/Display.tsx`), run for the Person looking at it. The display names the tool
 * `tool@account` as `find_tools` showed it; the server resolves that pair under the Person's own
 * access, exactly as it does for Vivid.
 *
 * A `Query` runs whenever the display is drawn or what it reads changes, with no press, so it may
 * only read: a tool that changes anything is refused. A `Mutation` runs only when the Person
 * presses the button that names it, with the fields they see; that press is their decision about
 * their own account, so it is not sent to the Gate for a second one.
 */
export const useDisplayTool = Effect.fn('Connections.useDisplayTool')(function* (
  actor: Actor,
  request: UseDisplayToolRequest,
) {
  const at = request.name.indexOf('@')
  if (at <= 0 || at === request.name.length - 1)
    return yield* new NotFound({ message: 'Name the tool as tool@account.' })
  const tool = yield* resolveTool(actor, {
    tool: request.name.slice(0, at),
    account: request.name.slice(at + 1),
  })
  const refusal = displayCallRefusal(displayCallPolicy(request.kind), tool.effect)
  if (Option.isSome(refusal))
    return ToolOutcome.cases.Rejected.make({
      message: refusal.value,
    })
  const row = (yield* (yield* ConnectionStore).records(actor)).find(
    (record) => record.id === tool.connectionId,
  )
  if (row === undefined) return yield* new NotFound({ message: 'Tool not found' })
  return yield* runConnection(
    actor,
    row,
    ActionTarget.cases.Connection.make({
      connectionId: row.id,
      account: tool.account,
      tool: tool.name,
      input: request.input,
    }),
  ).pipe(
    Effect.catchTag('ExecutorApprovalUnsupported', () =>
      Effect.fail(new DisplayApprovalUnsupported({})),
    ),
  )
})

/** Approved execution carries the shared Tool decision as an action receipt without recording again. */
const actionOutcome = (outcome: ToolOutcome) =>
  ToolOutcome.match<ActionOutcome>(outcome, {
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

/** Both admission absence and access failure retain the pre-recording approved reason. */
const unavailableActionReason =
  'The integration is no longer available; check its authorization and your access.'

/** Only a missing record or revoked permission proves that this delayed action did not run. */
const unavailableAction = () =>
  Effect.succeed(
    ActionOutcome.cases.Failed.make({
      reason: unavailableActionReason,
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
    const prepared = yield* prepareTool(actor, input.target).pipe(
      // Discovery precedes dispatch; an infrastructure fault here is retryable, never uncertain.
      Effect.catchTag(
        'ServiceUnavailable',
        Effect.fnUntraced(function* () {
          // Discovery failed before dispatch, so this caller decides one retryable Tool refusal.
          yield* recordRefusal(
            Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }),
          )
          return yield* new InvalidRequest({
            message: 'Tool discovery failed before the action was sent. Retry discovery.',
          })
        }),
      ),
    )
    if (Result.isFailure(prepared)) return approvedAdmissionOutcome(prepared.failure)
    const { row } = prepared.success
    return actionOutcome(yield* runConnection(actor, row, input.target))
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        // workspaceIn/requireCompany access failures belong to their boundary and have no Refusal case.
        // Missing scoped Integration records are instead decided and recorded by prepareTool above.
        NotFound: unavailableAction,
        Forbidden: unavailableAction,
        ServiceUnavailable: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseUnavailable: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseConstraintViolation: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        DatabaseFailure: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        Conflict: () => Effect.succeed(ActionOutcome.cases.Unknown.make({})),
        InvalidRequest: ({ message }) =>
          Effect.succeed(ActionOutcome.cases.Failed.make({ reason: message })),
        ExecutorApprovalUnsupported: () =>
          Effect.succeed(
            ActionOutcome.cases.Failed.make({
              reason: 'This Integration action needs an approval Vivid cannot give yet.',
            }),
          ),
      }),
    ),
)

/**
 * Offers use actual catalog entries and the same ownership rules as discovery.
 *
 * Vivid asks for one of two things. The service at all: any ready account answers, so the card
 * says whether the Person already has one. Or one more account than the Person has now (their
 * work Gmail beside their personal one): no present account answers that, so the card is never
 * ready when it is made, and it carries the moment Vivid asked. Only an account begun after that
 * moment is the one that was asked for (`AnotherAccountMessage`). Asking for one more where there
 * is none yet is asking for the service, and is answered as that.
 */
export const offerConnection = Effect.fn('Connections.offer')(function* (
  actor: Actor,
  request: OfferConnectionRequest,
) {
  const store = yield* ConnectionStore
  const service = yield* store.service(request.service)
  if (ServiceAuthorization.guards.SetupRequired(service.authorization))
    return yield* new InvalidRequest({ message: connectionSetupMessage })
  const ready = (yield* store.records(actor)).some(
    (row) => row.service === service.id && row.status === 'ready',
  )
  if (request.wanted === 'Another' && ready)
    return AnotherAccountMessage.make({
      kind: 'connection-request',
      service: service.id,
      serviceName: service.name,
      reason: request.reason,
      ready: false,
      another: { askedAt: yield* Clock.currentTimeMillis },
    })
  return ConnectionRequestMessage.make({
    kind: 'connection-request',
    service: service.id,
    serviceName: service.name,
    reason: request.reason,
    ready,
  })
})
