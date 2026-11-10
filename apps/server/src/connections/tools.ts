import { IntegrationAnswers } from './answers.ts'
import { Array as Arr, Clock, Duration, Effect, Option, Order, Result, Schema } from 'effect'
import {
  ActionReceipt,
  ApprovalBinding,
  ActionTarget,
  AnotherAccountMessage,
  ConnectionRequestMessage,
  ConnectionTool,
  DiscoveredTool,
  ConnectionState,
  ConnectionGrant,
  IntegrationResult,
  type ActionEffect,
  InvalidRequest,
  NotFound,
  ProposedAction,
  ServiceAuthorization,
  ToolOutcome,
  DisplayApprovalUnsupported,
  Workspace,
  type ActionOperationId,
  type FindToolsRequest,
  type PersonId,
  type RunId,
  type ThreadId,
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
import { actingRun } from '../threads/runs.ts'
import { Watches } from '../watches/lifecycle.ts'
import {
  Claim,
  answerBefore,
  claim,
  operationOf,
  release,
  resultDigest,
  settle,
} from '../actions/journal.ts'
import {
  ExecutorCallOutcome,
  ExecutorTool,
  ExecutorResourceMissing,
  ExecutorApprovalUnsupported,
  connectionSetupMessage,
  resourceReason,
} from './executor.ts'
import { operationsOf } from './members.ts'
import { prepareReconciliation } from './reconcile.ts'
import { callableTool, discoveredTool } from '../code/signatures.ts'
import { executorFailure } from './errors.ts'
import { ConnectionStore, ToolDiscovery } from './store.ts'
import { decisionConfigured, isDecisionNonEvent } from '../decisions/model.ts'
import { relevantTools, relevantToolsWithin, RELEVANCE_BUDGET } from './relevance.ts'
import { ToolEffects } from './effects.ts'
import { stateOf, grantOf, type ConnectionRecord } from './records.ts'
import { notRead, observedResult } from './coverage.ts'
import { permissionRefusal } from './permissions.ts'
import { namedAccounts } from './names.ts'
import { bindDocuments } from '../artifacts/store.ts'
import { namedDocuments } from '../artifacts/placeholder.ts'
import { bindFiles } from './files.ts'

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

/** A dispatch without a conclusive result remains held by the original operation, including a lost question write. */
const unknownConnection = Effect.fn('Connections.unknown')(function* (
  operation: Option.Option<ActionOperationId>,
  call: {
    readonly service: Service['id']
    readonly target: typeof ActionTarget.cases.Connection.Type
    readonly effect: ActionEffect
  },
) {
  const observedAt = yield* Clock.currentTimeMillis
  const receipt = Option.map(operation, (operationId) =>
    ActionReceipt.cases.Unknown.make({ operationId, observedAt }),
  )
  return yield* observedResult(
    ToolOutcome.cases.OutcomeUnknown.make({ receipt: Option.getOrNull(receipt) }),
    call,
  )
})

/** Reads acquire a journal row only after Executor reports a pause; a previously claimed read is never asked again. */
const claimPausedRead = Effect.fn('Connections.claimPausedRead')(function* (
  actor: Actor,
  target: typeof ActionTarget.cases.Connection.Type,
  input: { readonly effect: ActionEffect; readonly operation: Option.Option<ActionOperationId> },
) {
  if (input.effect !== 'read' || Option.isNone(input.operation))
    return Option.none<import('@vivid/contracts').ActionReceipt>()
  // Approved reads already own a journal row; their runner intentionally carries no Thread on the Actor.
  if (Option.isNone(actor.threadId)) return Option.none<import('@vivid/contracts').ActionReceipt>()
  const claimed = yield* claim({
    id: input.operation.value,
    threadId: actor.threadId.value,
    runId: yield* runOf(actor.threadId.value, actor.person.id),
    approvalId: null,
    target,
  }).pipe(
    Effect.mapError(
      () =>
        new InvalidRequest({
          message: 'The earlier Integration question must be reconciled before asking again.',
        }),
    ),
  )
  return Claim.guards.Answered(claimed) ? Option.some(claimed.receipt) : Option.none()
})

/** Save the remote question under its original operation; a display press without one cannot offer a continuation. */
const pauseConnection = Effect.fn('Connections.pause')(function* (
  actor: Actor,
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
  input: {
    readonly effect: ActionEffect
    readonly operation: Option.Option<ActionOperationId>
    readonly pause: import('@vivid/contracts').IntegrationPause
  },
) {
  if (Option.isNone(input.operation))
    return yield* ExecutorApprovalUnsupported.make({ tool: target.tool })
  const prior = yield* claimPausedRead(actor, target, input)
  if (Option.isSome(prior)) return yield* notRead(answeredOutcome(prior.value))
  const lostQuestion = () =>
    unknownConnection(input.operation, { service: row.service, target, effect: input.effect })
  return yield* (yield* IntegrationAnswers)
    .pause(
      actor,
      ProposedAction.make({
        summary: `The Integration asks to run ${target.tool}`,
        rationale: input.pause.form.message,
        effect: input.effect,
        target,
        continuation: { pause: input.pause, operation: input.operation.value },
      }),
    )
    .pipe(
      Effect.catchTags({
        // The remote call already paused. Losing its product question must never release the operation for another send.
        NotFound: lostQuestion,
        InvalidRequest: lostQuestion,
        DatabaseUnavailable: lostQuestion,
        DatabaseConstraintViolation: lostQuestion,
        DatabaseFailure: lostQuestion,
      }),
    )
})

/** A Gate authorizes dispatch. Pauses keep the same operation; only provider evidence settles its receipt. */
export const runConnection = Effect.fn('Connections.run')(
  function* (
    actor: Actor,
    row: ConnectionRecord,
    target: typeof ActionTarget.cases.Connection.Type,
    call: {
      readonly effect: ActionEffect
      readonly operation: Option.Option<ActionOperationId>
      readonly policy: DisplayCallPolicy
    },
  ) {
    const { effect, operation } = call
    const refusal = yield* permissionRefusal(row)
    if (Option.isSome(refusal)) return yield* notRead(refusal.value)
    const sending =
      Option.isSome(operation) && effect !== 'read'
        ? yield* prepareReconciliation(row, target, operation.value)
        : target
    const outcome = yield* (yield* operationsOf(row))
      .call({ references: row.references, tool: sending.tool, input: sending.input })
      .pipe(
        Effect.mapError((error) =>
          isResourceMissing(error) || isApprovalUnsupported(error) ? error : executorFailure(error),
        ),
      )
    return yield* ExecutorCallOutcome.match<
      Effect.Effect<
        IntegrationResult,
        | import('@vivid/contracts').NotFound
        | ReturnType<typeof executorFailure>
        | ExecutorApprovalUnsupported
        | import('@vivid/contracts').Conflict
        | import('../database/client.ts').DatabaseInfrastructureError,
        ConnectionStore | IntegrationAnswers | import('../database/client.ts').Database
      >
    >(outcome, {
      UncertainPause: Effect.fnUntraced(function* () {
        if (DisplayCallPolicy.guards.Draw(call.policy))
          return yield* notRead(
            ToolOutcome.cases.Rejected.make({
              message:
                'This Integration needs the Person before it can continue. Ask in the Thread.',
            }),
          )
        yield* claimPausedRead(actor, target, call)
        const uncertain = yield* unknownConnection(operation, {
          service: row.service,
          target,
          effect,
        })
        if (
          ToolOutcome.guards.OutcomeUnknown(uncertain.outcome) &&
          uncertain.outcome.receipt !== null
        )
          yield* settle(uncertain.outcome.receipt)
        return uncertain
      }),
      Paused: ({ pause }) =>
        DisplayCallPolicy.match(call.policy, {
          Draw: () =>
            notRead(
              ToolOutcome.cases.Rejected.make({
                message:
                  'This Integration needs the Person before it can continue. Ask in the Thread.',
              }),
            ),
          Press: () => pauseConnection(actor, row, target, { effect, operation, pause }),
        }),
      Expired: () =>
        unknownConnection(
          Option.filter(operation, () => effect !== 'read'),
          { service: row.service, target, effect },
        ),
      Accepted: Effect.fnUntraced(function* ({ value }) {
        const acceptedAt = yield* Clock.currentTimeMillis
        const receipt = Option.map(
          Option.filter(operation, () => effect !== 'read'),
          (operationId) => ActionReceipt.cases.Accepted.make({ operationId, acceptedAt }),
        )
        return yield* observedResult(
          ToolOutcome.cases.Accepted.make({ output: value, receipt: Option.getOrNull(receipt) }),
          { service: row.service, target, effect },
        )
      }),
      Completed: Effect.fnUntraced(function* ({ value }) {
        const completedAt = yield* Clock.currentTimeMillis
        const receipt = Option.map(
          Option.filter(operation, () => effect !== 'read'),
          (operationId) =>
            ActionReceipt.cases.Completed.make({
              operationId,
              completedAt,
              resultDigest: resultDigest(value),
            }),
        )
        return yield* observedResult(
          ToolOutcome.cases.Completed.make({ output: value, receipt: Option.getOrNull(receipt) }),
          { service: row.service, target, effect },
        )
      }),
      Rejected: Effect.fnUntraced(function* ({ message, problems }) {
        // The service answer becomes a Tool rejection here; its private message is never recorded.
        yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'ServiceRejected' }))
        return yield* observedResult(ToolOutcome.cases.Rejected.make({ message, problems }), {
          service: row.service,
          target,
          effect,
        })
      }),
      OutcomeUnknown: () =>
        unknownConnection(
          Option.filter(operation, () => effect !== 'read'),
          { service: row.service, target, effect },
        ),
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
          return yield* notRead(ToolOutcome.cases.Rejected.make({ message: reason }))
        }),
      ),
    ),
)

/** Observed authorization loss refreshes screens without guessing whether authority expired or was revoked. */
const markNotReady = Effect.fn('Connections.markNotReady')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  yield* (yield* ConnectionStore)
    .notReady(actor, row)
    .pipe(Effect.catchTag('Conflict', () => Effect.void))
  // Authorization loss decides NotReady after updating the Integration's durable state.
  yield* recordRefusal(Refusal.cases.IntegrationNotReady.make({ service: row.service }))
  return yield* notRead(
    ToolOutcome.cases.ConnectionNotReady.make({
      service: row.service,
      serviceName: row.serviceName,
      grant: ConnectionGrant.cases.ReauthorizationRequired.make({}),
    }),
  )
})

/** Admission facts stay separate from caller receipts: approved actions retain their original
 * outcome and prose while direct tool calls retain theirs (tools.ts at 9f0eda42). */
const ToolAdmissionRefusal = Schema.TaggedUnion({
  IntegrationUnavailable: {},
  IntegrationFailed: { reason: Schema.String },
  NeedsAuthorization: {
    service: ToolOutcome.cases.ConnectionNotReady.fields.service,
    serviceName: Schema.String,
    grant: ConnectionGrant,
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
    NeedsAuthorization: ({ service, serviceName, grant }) =>
      ToolOutcome.cases.ConnectionNotReady.make({ service, serviceName, grant }),
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
            grant: grantOf(row),
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
          grant: ConnectionGrant.cases.ReauthorizationRequired.make({}),
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
  // A legacy row gains its first grant observation during discovery; retain that revision for later loss.
  const current = ConnectionGrant.guards.Unverified(grantOf(row))
    ? yield* store.get(actor, row.id)
    : row
  return Result.succeed({ row: current, tool })
})

/**
 * The call's input with the Thread's documents it names copied in, or the refusal Vivid reads when
 * one of them is not there. A document is named within the acting Thread only; a call with no
 * Thread (a display's) names none.
 */
const bindDocumentInput = Effect.fn('Connections.bindDocumentInput')(function* (
  actor: Actor,
  input: Schema.Json,
) {
  if (Option.isNone(actor.threadId))
    return namedDocuments(input).length === 0
      ? Result.succeed({ input, preconditions: [] })
      : Result.fail(
          ToolOutcome.cases.Rejected.make({ message: 'Documents can be named only in a Thread.' }),
        )
  return yield* bindDocuments(actor.person.id, actor.threadId.value, input).pipe(
    Effect.map(Result.succeed),
    Effect.catchTag('DocumentNotFound', ({ title, titles }) =>
      Effect.succeed(
        Result.fail(
          ToolOutcome.cases.Rejected.make({
            message:
              titles.length === 0
                ? `This Thread has no document titled "${title}", and no documents at all.`
                : `This Thread has no document titled "${title}". Its documents are: ${titles.join(', ')}.`,
          }),
        ),
      ),
    ),
  )
})

/** File refusals are model-readable data, decided before approval and Executor dispatch. */
const bindInput = Effect.fn('Connections.bindInput')(function* (actor: Actor, input: Schema.Json) {
  const files = yield* bindFiles(actor, input).pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({
      IntegrationFileUnavailable: ({ name }) =>
        Effect.succeed(
          Result.fail(
            ToolOutcome.cases.Rejected.make({
              message: `File "${name}" is unavailable or its name is ambiguous on your own shelf or Thread.`,
            }),
          ),
        ),
      IntegrationFileTooLarge: ({ limit }) =>
        Effect.succeed(
          Result.fail(
            ToolOutcome.cases.Rejected.make({
              message: `Integration files exceed the ${limit} byte total limit.`,
            }),
          ),
        ),
      IntegrationFileReferenceInvalid: () =>
        Effect.succeed(
          Result.fail(
            ToolOutcome.cases.Rejected.make({
              message: 'Use {"$file":{"source":"artifact" or "library","name":"visible name"}}.',
            }),
          ),
        ),
    }),
  )
  if (Result.isFailure(files)) return files
  return yield* bindDocumentInput(actor, files.success)
})

/** One Integration call as Vivid asks for it, before the server names its operation. */
type ToolRequest = Omit<UseToolRequest, 'toolCallId'>

/** What the journal already knows answers the call in place of sending it again. */
const answeredOutcome = (receipt: ActionReceipt) =>
  ActionReceipt.guards.Unknown(receipt)
    ? ToolOutcome.cases.OutcomeUnknown.make({ receipt })
    : ToolOutcome.cases.Repeated.make({ receipt })

/** The Run a journaled call belongs to; a call with no admitted working Run names none. */
const runOf = (threadId: ThreadId, personId: PersonId) =>
  actingRun(threadId, personId).pipe(
    Effect.map((run): RunId | null => run),
    Effect.catchTag('NoActingRun', () => Effect.succeed(null)),
  )

/**
 * Sends one outward write under the journal: claim first, then send, then record the receipt the
 * adapter chose. A claim answered from the journal is not sent. A definite refusal, or a failure
 * before the call reached the provider, releases the claim: nothing outward happened. An
 * interruption mid-send leaves the claim `Dispatching`, which reads as uncertain.
 */
const sendJournaled = Effect.fn('Connections.sendJournaled')(function* (
  actor: Actor,
  row: ConnectionRecord,
  target: typeof ActionTarget.cases.Connection.Type,
  call: {
    readonly effect: ActionEffect
    readonly journal: { readonly id: ActionOperationId; readonly threadId: ThreadId }
  },
) {
  const operation = call.journal
  const claimed = yield* claim({
    id: operation.id,
    threadId: operation.threadId,
    runId: yield* runOf(operation.threadId, actor.person.id),
    approvalId: null,
    target,
  })
  if (Claim.guards.Answered(claimed)) return yield* notRead(answeredOutcome(claimed.receipt))
  const result = yield* runConnection(actor, row, target, {
    effect: call.effect,
    operation: Option.some(operation.id),
    policy: DisplayCallPolicy.cases.Press.make({}),
  }).pipe(Effect.tapError(() => release(operation.id)))
  yield* ToolOutcome.match(result.outcome, {
    Accepted: ({ receipt }) => (receipt === null ? Effect.void : settle(receipt)),
    Completed: ({ receipt }) => (receipt === null ? Effect.void : settle(receipt)),
    OutcomeUnknown: ({ receipt }) => (receipt === null ? Effect.void : settle(receipt)),
    Rejected: () => release(operation.id),
    ConnectionNotReady: () => release(operation.id),
    // Permission refusals are decided before dispatch: nothing outward happened.
    ScopeRequired: () => release(operation.id),
    PermissionDeclined: () => release(operation.id),
    Unsupported: () => release(operation.id),
    Repeated: () => Effect.void,
    ApprovalRequired: () => Effect.void,
    InputRequired: () => Effect.void,
    Blocked: () => Effect.void,
  })
  return result
})

/**
 * Tool refusals are data; permission and effect come from ownership and provider metadata.
 *
 * A write in a Thread is journaled under `operation`'s key. Before the Gate the journal is asked
 * whether this exact act must be answered or refused instead, so an act whose earlier send is
 * unresolved is never proposed again as a new Approval either.
 */
const useToolAs = Effect.fn('Connections.useTool')(function* (
  actor: Actor,
  request: ToolRequest,
  policy: DisplayCallPolicy,
  operation: (threadId: ThreadId) => ActionOperationId,
) {
  const prepared = yield* prepareTool(actor, request)
  if (Result.isFailure(prepared)) {
    // The one admission refusal `prepareTool` leaves to its caller: here a discovery conflict is
    // a rejection the program reads, so it is counted here and nowhere else.
    if (ToolAdmissionRefusal.guards.DiscoveryConflict(prepared.failure))
      yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return yield* notRead(toolAdmissionOutcome(prepared.failure))
  }
  const { row, tool } = prepared.success
  // Discovery may change after name resolution. Recheck at the last admission before the Gate.
  const refusal = displayCallRefusal(policy, tool.effect)
  if (Option.isSome(refusal)) {
    yield* recordRefusal(Refusal.cases.CallRefused.make({ call: 'use_tool' }))
    return yield* notRead(
      ToolOutcome.cases.Rejected.make({
        message: refusal.value,
      }),
    )
  }
  // An Approval names the account as discovery named it to Vivid, so the Person is asked about
  // "Gmail (Work)" and never about a bare "Gmail" that could be either of two.
  const named = namedAccounts(yield* (yield* ConnectionStore).records(actor)).find(
    (entry) => entry.row.id === row.id,
  )
  if (named === undefined) {
    // Removed between admission and here: there is no account left to name or to act through.
    yield* recordRefusal(Refusal.cases.ToolRejected.make({ reason: 'IntegrationUnavailable' }))
    return yield* notRead(
      toolAdmissionOutcome(ToolAdmissionRefusal.cases.IntegrationUnavailable.make({})),
    )
  }
  // A call may name a Thread document where its text goes (`artifacts/placeholder.ts`), because
  // the model must not paste a body the Person may still revise. The newest text is copied in
  // here, before the Gate and the digest, so an Approval shows exactly what would be sent and is
  // bound to the version it was copied from.
  const bound = yield* bindInput(actor, request.input)
  if (Result.isFailure(bound)) return yield* notRead(bound.failure)
  const target = ActionTarget.cases.Connection.make({
    connectionId: row.id,
    account: named.account,
    tool: tool.name,
    input: bound.success.input,
  })
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: request.rationale,
    effect: tool.effect,
    target,
  })
  const prospective = Option.map(actor.threadId, (threadId) => ({
    id: operation(threadId),
    threadId,
  }))
  const journaled = Option.filter(prospective, () => tool.effect !== 'read')
  if (Option.isSome(prospective)) {
    const answer = yield* answerBefore({ ...prospective.value, target })
    if (Option.isSome(answer)) return yield* notRead(answeredOutcome(answer.value))
  }
  const decision = yield* (yield* Gate).check(
    actor,
    action,
    yield* exposureOf(actor, row),
    ApprovalBinding.make({
      connectionGeneration: row.authorizationGeneration,
      preconditions: bound.success.preconditions,
    }),
  )
  return yield* GateDecision.match<ReturnType<typeof sendJournaled>>(decision, {
    Blocked: ({ rule }) => notRead(ToolOutcome.cases.Blocked.make({ rule })),
    ApprovalRequired: ({ approval }) =>
      notRead(
        ToolOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: () =>
      Option.match(journaled, {
        onNone: () =>
          runConnection(actor, row, target, {
            effect: tool.effect,
            operation: Option.map(prospective, (value) => value.id),
            policy,
          }),
        onSome: (journal) => sendJournaled(actor, row, target, { effect: tool.effect, journal }),
      }),
  }).pipe(
    Effect.catchTag('ExecutorApprovalUnsupported', (error) => Effect.fail(executorFailure(error))),
  )
})

/** Vivid's regular calls retain their existing Gate policy, journaled under the runtime's call. */
export const useTool = (actor: Actor, request: UseToolRequest) =>
  useToolAs(actor, request, DisplayCallPolicy.cases.Press.make({}), (threadId) =>
    operationOf.call(threadId, request.toolCallId),
  )

/**
 * A call with no retry identity of its own: a program's call (programs are never replayed) or the
 * server's own test call. The same Gate; each write is journaled under a fresh operation.
 */
export const useUnkeyedTool = (actor: Actor, request: ToolRequest) =>
  useToolAs(actor, request, DisplayCallPolicy.cases.Press.make({}), operationOf.program)

/** Only an actual Vivid dispatch or approved replay may confirm a check-in's timer receipt. */
const recordTimerOutcome = Effect.fn('Connections.recordTimer')(function* (
  actor: Actor,
  request: Pick<UseToolRequest, 'connectionId' | 'input'>,
  { outcome }: IntegrationResult,
) {
  // A call that reached the timer reports its receipt; anything stopped before it left Vivid
  // (an Approval, a rule, a sign-in) leaves the check-in Awaiting without failing the call.
  if (!ToolOutcome.isAnyOf(['Completed', 'Rejected', 'OutcomeUnknown'])(outcome)) return
  const output = ToolOutcome.guards.Completed(outcome) ? outcome.output : null
  yield* (yield* Watches).confirmTimer(actor, request.connectionId, request.input, output)
})

/** Timer receipt confirmation belongs to the model tool boundary, not display calls or read probes. */
export const useVividTool = Effect.fn('Connections.useVividTool')(function* (
  actor: Actor,
  request: UseToolRequest,
) {
  const outcome = yield* useTool(actor, request)
  yield* recordTimerOutcome(actor, request, outcome)
  return outcome
})

/** Automatic display programs require a read effect at final admission, even after rediscovery. */
export const useQueryTool = (actor: Actor, request: ToolRequest) =>
  useToolAs(actor, request, DisplayCallPolicy.cases.Draw.make({}), operationOf.program)

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
  const account = namedAccounts(yield* (yield* ConnectionStore).records(actor)).find(
    (entry) =>
      entry.account.toLowerCase() ===
      request.name
        .slice(at + 1)
        .trim()
        .toLowerCase(),
  )
  if (account === undefined) return yield* new NotFound({ message: 'Tool not found' })
  const prepared = yield* prepareTool(actor, {
    connectionId: account.row.id,
    tool: request.name.slice(0, at),
  })
  if (Result.isFailure(prepared)) return yield* notRead(toolAdmissionOutcome(prepared.failure))
  const { row, tool } = prepared.success
  const refusal = displayCallRefusal(displayCallPolicy(request.kind), tool.effect)
  if (Option.isSome(refusal))
    return yield* notRead(ToolOutcome.cases.Rejected.make({ message: refusal.value }))
  // A Person's own press on their display is not journaled here (a follow-up of the action journal).
  return yield* runConnection(
    actor,
    row,
    ActionTarget.cases.Connection.make({
      connectionId: row.id,
      account: account.account,
      tool: tool.name,
      input: request.input,
    }),
    { effect: tool.effect, operation: Option.none(), policy: displayCallPolicy(request.kind) },
  ).pipe(
    Effect.catchTag('ExecutorApprovalUnsupported', () =>
      Effect.fail(new DisplayApprovalUnsupported({})),
    ),
  )
})

/** Approved execution carries the shared Tool decision as an action receipt without recording again. */
const actionOutcome = (result: IntegrationResult) =>
  ToolOutcome.match<ActionOutcome>(result.outcome, {
    Accepted: () =>
      ActionOutcome.cases.Succeeded.make({
        result: 'The service accepted the action; its result is not confirmed yet.',
      }),
    InputRequired: () => ActionOutcome.cases.Waiting.make({}),
    Completed: ({ output }) =>
      ActionOutcome.cases.Succeeded.make({ result: JSON.stringify(output).slice(0, 4000) }),
    Rejected: ({ message }) => ActionOutcome.cases.Failed.make({ reason: message }),
    ScopeRequired: () =>
      ActionOutcome.cases.Failed.make({ reason: 'Additional Integration access is required.' }),
    PermissionDeclined: () =>
      ActionOutcome.cases.Failed.make({ reason: 'Integration data permission was declined.' }),
    Unsupported: ({ capability }) =>
      ActionOutcome.cases.Failed.make({ reason: `Unsupported capability: ${capability}` }),
    ConnectionNotReady: () =>
      ActionOutcome.cases.Failed.make({ reason: 'This integration needs authorization.' }),
    OutcomeUnknown: () => ActionOutcome.cases.Unknown.make({}),
    Repeated: () =>
      ActionOutcome.cases.Succeeded.make({
        result: 'This exact action was already sent. Its receipt says whether it finished.',
      }),
    Blocked: ({ rule }) => ActionOutcome.cases.Failed.make({ reason: rule }),
    ApprovalRequired: () => ActionOutcome.cases.Waiting.make({}),
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
    readonly operation: Option.Option<ActionOperationId>
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
    const actor: Actor = {
      person: input.person,
      workspace,
      by: 'vivid',
      threadId: Option.none(),
      helper: Option.none(),
    }
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
    const { row, tool } = prepared.success
    // The Approval's decision journals this operation around the runner (`approvals/store.ts`).
    const outcome = yield* runConnection(actor, row, input.target, {
      effect: tool.effect,
      operation: input.operation,
      policy: DisplayCallPolicy.cases.Press.make({}),
    })
    yield* recordTimerOutcome(actor, input.target, outcome)
    return actionOutcome(outcome)
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
        CheckinNotScheduled: ({ message }) =>
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
