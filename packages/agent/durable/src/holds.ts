import type * as DurableErrors from './errors.ts'
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type HookApi,
  type EntryRecord,
  type SnapshotEvent,
  LiveDoc,
  type TaskId,
  type ToolSlot,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import type { asSchema } from 'ai'
import type { Message, TextContent, ImageContent, ToolCall } from '@earendil-works/pi-ai'
import { Deferred, Effect, Match, Option, Predicate, Schema, Result } from 'effect'

import * as Pi from './pi.ts'
import { type Question } from './delivery.ts'
import { deliver } from './answers.ts'
import {
  CallNotWaiting,
  HoldId,
  ToolApprovalFailed,
  ToolApprovalUnsupported,
  ToolApprovalContextUnavailable,
  PiFailed,
} from './errors.ts'
import { waiting, type Waiting } from './waiting.ts'

/**
 * How one held tool call was settled by whoever it waited for.
 *
 * A hold is a tool call that cannot continue alone: it needs a person to approve it, or a person
 * (or another system) to supply its result. The settlement is durable; the wait for it is not, so a
 * restart finds the settlement or waits again.
 */
export type Settlement =
  | { kind: 'approved' }
  | { kind: 'denied'; reason: string }
  | { kind: 'answered'; output: JsonValue }
  | { kind: 'errored'; errorText: string }

/** A provider's call id may be reused; Pi's durable task id identifies the exact held invocation. */
export type Settled = {
  taskId: TaskId
  callId: string
  settlement: Settlement
  presentation?: { dynamic: boolean; title: string | null }
}

/**
 * Durable hold state of one conversation.
 *
 * `settled` and `asked` are keyed by opaque hold ids derived from Pi tasks. Receipts and
 * unanswered questions survive provider call-id reuse and transcript compaction independently.
 * `asked` retains answer-later calls through durable output reservation and submission admission;
 * only placement retires them to settled receipts. Withdrawal reopens a submitted question without
 * losing a queued answer; a withdrawn attempt accepts the next answer. The tool's name supplies the late-answer user message. Latest-only: a hold belongs to a run in progress, never to a rewound transcript.
 */
export const Holds = defineDoc<{
  settled: Record<string, Settled>
  // Older questions predate late projection; only those legitimately lack the retained SDK input.
  asked: Record<string, Question & { readonly input?: JsonValue }>
}>({
  kind: 'durable.holds',
  version: 5,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ settled: {}, asked: {} }),
})

/** Pi types.ts defines task identities as erased numeric brands; no new identity is invented here. */
const TaskIdentity = Schema.declare<TaskId>((value): value is TaskId => Predicate.isNumber(value))
const SettlementValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('approved') }),
  Schema.Struct({ kind: Schema.Literal('denied'), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('answered'), output: Schema.MutableJson }),
  Schema.Struct({ kind: Schema.Literal('errored'), errorText: Schema.String }),
])

/** Only the slot/generation presentation is needed; atomic event snapshots and live docs agree here. */
export type CallState = Pick<SnapshotEvent, 'generation'> & { readonly tools?: readonly ToolSlot[] }

/** Hooks address their exact task; public calls require unique ids and completed-entry provenance. */
export const CallIdentity = Schema.TaggedUnion({
  Hold: { holdId: HoldId },
  Public: {
    callId: Schema.String,
    resultTask: Schema.Option(TaskIdentity),
    duplicate: Schema.Boolean,
  },
  Task: { callId: Schema.String, taskId: TaskIdentity, resultTask: Schema.Option(TaskIdentity) },
})
export type CallIdentity = typeof CallIdentity.Type

/** Only Ready may wait. Queued has no task yet; Duplicate cannot be addressed by the public API. */
export const CallLookup = Schema.TaggedUnion({
  Duplicate: {},
  Missing: {},
  Queued: {},
  Generating: {},
  Ready: { taskId: TaskIdentity, holdId: HoldId, callId: Schema.String },
  Executing: { taskId: TaskIdentity, holdId: HoldId, callId: Schema.String },
  Done: { taskId: TaskIdentity, holdId: HoldId, callId: Schema.String },
  Settled: {
    taskId: TaskIdentity,
    holdId: HoldId,
    callId: Schema.String,
    settlement: SettlementValue,
    presentation: Schema.Option(
      Schema.Struct({ dynamic: Schema.Boolean, title: Schema.NullOr(Schema.String) }),
    ),
  },
  Asked: { taskId: TaskIdentity, holdId: HoldId, callId: Schema.String, toolName: Schema.String },
})
export type CallLookup = typeof CallLookup.Type

type HoldState = {
  settled: Record<string, Settled>
  asked: Record<string, Question>
}

/** The newest assistant entry owns the call; an older run's result is never evidence for a new invocation. */
export function identify(entries: readonly EntryRecord[], callId: string) {
  return (
    identitiesFor(entries).get(callId) ??
    CallIdentity.cases.Public.make({ callId, resultTask: Option.none(), duplicate: false })
  )
}

/** Index the one observed transcript in append order; a new call replaces only its own provider-id context. */
export function identitiesFor(entries: readonly EntryRecord[]) {
  const identities = new Map<string, typeof CallIdentity.cases.Public.Type>()
  for (const entry of entries) {
    for (const message of entry.model ?? [])
      indexMessage(identities, message, Option.fromNullishOr(entry.byTaskId))
  }
  return identities
}

/** An assistant opens a generation of each call; its following tool result supplies task provenance. */
function indexMessage(
  identities: Map<string, typeof CallIdentity.cases.Public.Type>,
  message: Message,
  resultTask: Option.Option<TaskId>,
) {
  if (message.role === 'assistant') {
    const calls = message.content.filter((block) => block.type === 'toolCall')
    const counts = new Map<string, number>()
    for (const call of calls) counts.set(call.id, (counts.get(call.id) ?? 0) + 1)
    for (const call of calls)
      identities.set(
        call.id,
        CallIdentity.cases.Public.make({
          callId: call.id,
          resultTask: Option.none(),
          duplicate: counts.get(call.id) !== 1,
        }),
      )
  } else if (message.role === 'toolResult') {
    const identity = identities.get(message.toolCallId)
    if (identity !== undefined)
      identities.set(
        message.toolCallId,
        CallIdentity.cases.Public.make({
          callId: identity.callId,
          duplicate: identity.duplicate,
          resultTask,
        }),
      )
  }
}

/** The SDK's transcript is typed; select calls without flattening duplicate ids into a Map. */
export function callsIn(entry: EntryRecord) {
  const messages = entry.model
  if (messages === undefined) return []
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.filter(
          (block): block is Extract<typeof block, { type: 'toolCall' }> =>
            block.type === 'toolCall',
        )
      : [],
  )
}

/** Apply stored state only to this exact task, irrespective of pending/running/done status. */
function taskState(
  holds: Readonly<HoldState>,
  callId: string,
  slot: Pick<ToolSlot, 'taskId' | 'status'>,
) {
  const taskId = slot.taskId
  if (taskId === undefined) return CallLookup.cases.Queued.make({})
  const holdId = holdIdOf(taskId)
  const recorded = holds.settled[holdId]
  if (recorded !== undefined && recorded.taskId === taskId)
    return CallLookup.cases.Settled.make({
      taskId,
      holdId,
      callId,
      settlement: copySettlement(recorded.settlement),
      presentation: Option.fromNullishOr(recorded.presentation),
    })
  const asked = holds.asked[holdId]
  if (asked !== undefined && asked.taskId === taskId)
    return CallLookup.cases.Asked.make({ taskId, holdId, callId, toolName: asked.toolName })
  return Match.value(slot.status).pipe(
    Match.when('pending', () => CallLookup.cases.Ready.make({ taskId, holdId, callId })),
    Match.when('running', () => CallLookup.cases.Executing.make({ taskId, holdId, callId })),
    Match.when('done', () => CallLookup.cases.Done.make({ taskId, holdId, callId })),
    Match.exhaustive,
  )
}

/**
 * The sole safety lookup. A live id must be unique; a hook selects its slot by taskId. With no slot,
 * only the newest call's tool-result byTaskId can validate a settlement. In-flight generation calls
 * have no task yet and cannot inherit a prior run's settlement even before their slots are created.
 */
export function lookup(
  live: CallState,
  holds: Readonly<HoldState>,
  identity: CallIdentity,
): CallLookup {
  if (CallIdentity.guards.Hold(identity)) return lookupHold(live, holds, identity.holdId)
  const slots = live.tools ?? []
  const matching = slots.filter((slot) => slot.callId === identity.callId)
  if (matching.length > 1) return CallLookup.cases.Duplicate.make({})
  const slot = CallIdentity.guards.Public(identity)
    ? Option.fromNullishOr(matching[0])
    : Option.fromNullishOr(
        slots.find(
          (candidate) =>
            candidate.taskId === identity.taskId && candidate.callId === identity.callId,
        ),
      )
  if (Option.isSome(slot)) return taskState(holds, identity.callId, slot.value)
  if (matching.length > 0) return CallLookup.cases.Missing.make({})
  if (generatingCall(live, identity.callId)) return CallLookup.cases.Generating.make({})
  if (CallIdentity.guards.Public(identity)) {
    if (identity.duplicate) return CallLookup.cases.Duplicate.make({})
    return Option.match(identity.resultTask, {
      onNone: () => CallLookup.cases.Missing.make({}),
      onSome: (taskId) => taskState(holds, identity.callId, { taskId, status: 'done' }),
    })
  }
  return Option.contains(identity.resultTask, identity.taskId)
    ? taskState(holds, identity.callId, { taskId: identity.taskId, status: 'done' })
    : CallLookup.cases.Missing.make({})
}

/** Streamed arguments precede the tool-round commit and therefore have no task identity yet. */
function generatingCall(live: CallState, callId: string) {
  const generation = live.generation
  if (generation === undefined || generation.message === undefined) return false
  return generation.message.content.some(
    (block) => block.type === 'toolCall' && block.id === callId,
  )
}

/** A hold keeps its own receipt and question even after another task reuses the provider's call id. */
function lookupHold(live: CallState, holds: Readonly<HoldState>, holdId: HoldId): CallLookup {
  const recorded = holds.settled[holdId]
  if (recorded !== undefined)
    return CallLookup.cases.Settled.make({
      holdId,
      callId: recorded.callId,
      taskId: recorded.taskId,
      settlement: copySettlement(recorded.settlement),
      presentation: Option.fromNullishOr(recorded.presentation),
    })
  const asked = holds.asked[holdId]
  if (asked !== undefined)
    return CallLookup.cases.Asked.make({
      holdId,
      callId: asked.callId,
      taskId: asked.taskId,
      toolName: asked.toolName,
    })
  const slots = live.tools ?? []
  const slot = slots.find(
    (candidate) => candidate.taskId !== undefined && holdIdOf(candidate.taskId) === holdId,
  )
  if (slot === undefined) return CallLookup.cases.Missing.make({})
  if (slots.filter((candidate) => candidate.callId === slot.callId).length > 1)
    return CallLookup.cases.Duplicate.make({})
  return taskState(holds, slot.callId, slot)
}

/** Construction from Pi's trusted task identity, without parsing or inventing a new task. */
export const holdIdOf = (taskId: TaskId): HoldId => HoldId.make(`hold:${taskId}`)

/** Normalize genuine document absence to Pi's declared initial value, then use the same pure lookup. */
export function lookupSnapshots(
  live: Option.Option<CallState>,
  holds: Option.Option<Readonly<HoldState>>,
  identity: CallIdentity,
) {
  return lookup(
    Option.getOrElse(live, () => LiveDoc.definition.initial()),
    Option.getOrElse(holds, () => Holds.definition.initial()),
    identity,
  )
}

/** Pi drafts expire at commit; copy the closed settlement variant and any nested JSON result. */
function copySettlement(settled: Settlement): Settlement {
  return Match.value(settled).pipe(
    Match.when({ kind: 'approved' }, (): Settlement => ({ kind: 'approved' })),
    Match.when({ kind: 'denied' }, (denied): Settlement => ({
      kind: 'denied',
      reason: denied.reason,
    })),
    Match.when({ kind: 'answered' }, (answered): Settlement => ({
      kind: 'answered',
      output: copyJson(answered.output),
    })),
    Match.when({ kind: 'errored' }, (errored): Settlement => ({
      kind: 'errored',
      errorText: errored.errorText,
    })),
    Match.exhaustive,
  )
}

/**
 * Where a tool's result comes from.
 *
 * - `server`: the tool's own `execute`.
 * - `wait`: a person answers; the model waits inside the call.
 * - `later`: a person answers; the call returns at once and the answer arrives as a new message, so
 *   the model keeps working.
 */
export type Source = 'server' | 'wait' | 'later'

/** What the bridge decided for one tool: whether a call needs approval, and where its result comes from. */
export type Plan = {
  /** The host's declared global mode, used for native registrations without an explicit mode. */
  readonly execution: 'parallel' | 'sequential'
  readonly approval: (
    input: Parameters<NonNullable<ReturnType<typeof asSchema>['validate']>>[0],
  ) => boolean
  /** SDK ingress: Pi coercion followed by the SDK's parsed input, shared by all policy readers. */
  readonly parse: (call: ToolCall) => Effect.Effect<unknown, DurableErrors.ToolFailed>
  /** SDK identity and display metadata follow the registration through Pi's wrappers. */
  readonly dynamic: boolean
  readonly title: Option.Option<string>
  /** A late answer is user input, but its content still comes from the SDK's model projection. */
  readonly lateOutput: Option.Option<
    (args: {
      readonly input: JsonValue
      readonly output: JsonValue
      readonly toolCallId: string
    }) => Effect.Effect<(TextContent | ImageContent)[], DurableErrors.ToolOutputFailed>
  >
  readonly source: Source
}

/**
 * Key of the plan on a tool registration.
 *
 * A symbol property, not a side table: Pi Durable's `wrapTool` wrappers spread the registration,
 * which copies symbol properties, so a wrapped tool keeps its plan. Registered globally so two
 * copies of this module in one process agree.
 */
const planned = Symbol.for('durable.plan')

type Planned = ToolRegistration & { readonly [planned]?: Plan }

/** A registration that carries its plan. */
export const withPlan = (tool: ToolRegistration, plan: Plan): ToolRegistration =>
  Object.assign(tool, { [planned]: plan })

/** The optional symbol survives Pi's registration wrappers; unbridged tools have no plan. */
export const planOf = (tool: ToolRegistration): Option.Option<Plan> => {
  // SAFETY: only withPlan writes this globally registered symbol, with a Plan; Pi spreads registrations verbatim.
  return Option.fromNullishOr((tool as Planned)[planned])
}

/** A decision is JSON so the hook can pin it using Pi's first-writer-wins task memo. */
export const CallDecision = Schema.TaggedUnion({
  Held: { kind: Schema.Literals(['approval', 'answer']) },
  Free: {},
  Blocked: { reason: Schema.String },
})
export type CallDecision = typeof CallDecision.Type
export const decisionMemo = 'durable.tool.decision'

/** Task memos are shared across hooks; an extension may only trust its own first-writer pin. */
const DecisionPin = Schema.Struct({ owner: Schema.String, decision: CallDecision })
export type DecisionPin = typeof DecisionPin.Type
const decodeDecision = Schema.decodeUnknownEffect(DecisionPin)
/** Memo reads are public Pi I/O; an absent memo means hooks have not pinned this attempt yet. */
export const readPinnedDecision = Effect.fn('Durable.readPinnedDecision')(function* (
  api: HookApi,
  context: Context,
): Effect.fn.Return<Option.Option<DecisionPin>, PiFailed> {
  const stored = yield* Effect.tryPromise({
    try: () => api.memo(decisionMemo, context),
    catch: (cause) => new PiFailed({ operation: 'snapshot', cause }),
  })
  if (stored === undefined) return Option.none<DecisionPin>()
  return Option.some(
    yield* decodeDecision(stored).pipe(
      Effect.mapError((cause) => new PiFailed({ operation: 'snapshot', cause })),
    ),
  )
})
/** Pin before waiting; after process death Pi returns the durable first writer without rerunning policy. */
export const pinDecision = Effect.fn('Durable.pinDecision')(function* (
  api: HookApi,
  chosen: DecisionPin,
  context: Context,
): Effect.fn.Return<DecisionPin, PiFailed> {
  const stored = yield* Effect.tryPromise({
    try: () => api.memo(decisionMemo, chosen, context),
    catch: (cause) => new PiFailed({ operation: 'commit', cause }),
  })
  return yield* decodeDecision(stored).pipe(
    Effect.mapError((cause) => new PiFailed({ operation: 'snapshot', cause })),
  )
})
/** A pull reader observes the live memo through getTask; terminal tasks legitimately have no memo. */
export const taskDecision: (
  harness: Harness,
  taskId: TaskId,
  context: Context,
) => Effect.Effect<Option.Option<CallDecision>, PiFailed> = Effect.fn('Durable.taskDecision')(
  function* (
    harness: Harness,
    taskId: TaskId,
    context: Context,
  ): Effect.fn.Return<Option.Option<CallDecision>, PiFailed> {
    const task = yield* Effect.tryPromise({
      try: () => harness.getTask(taskId, context),
      catch: (cause) => new PiFailed({ operation: 'snapshot', cause }),
    })
    const stored = Option.fromNullishOr(task).pipe(
      Option.flatMapNullishOr((record) => record.memos),
      Option.flatMapNullishOr((memos) => memos[decisionMemo]),
    )
    return yield* Option.match(stored, {
      onNone: () => Effect.succeed(Option.none<CallDecision>()),
      onSome: (value) =>
        decodeDecision(value).pipe(
          Effect.map((pin) => Option.some(pin.decision)),
          Effect.mapError((cause) => new PiFailed({ operation: 'snapshot', cause })),
        ),
    })
  },
)

/** Both pull and presentation readers prefer the durable hook pin over a changed registration. */
export const readerDecision = Effect.fn('Durable.readerDecision')(function* (
  harness: Harness,
  input: { taskId: Option.Option<TaskId>; plan: Option.Option<Plan>; call: ToolCall },
  context: Context,
): Effect.fn.Return<CallDecision, PiFailed> {
  const stored = yield* Option.match(input.taskId, {
    onNone: () => Effect.succeed(Option.none<CallDecision>()),
    onSome: (taskId) => taskDecision(harness, taskId, context),
  })
  if (Option.isSome(stored)) return stored.value
  return yield* Option.match(input.plan, {
    onNone: () => Effect.succeed(CallDecision.cases.Free.make({})),
    onSome: (plan) => decision(plan, input.call),
  })
})

/** Identical parsing and a contained synchronous policy are used in hooks and every active reader.
 * SDK input is opaque until the SDK validator decodes it; transforms need not produce JSON. */
export const decision = Effect.fn('Durable.toolDecision')(function* (
  plan: Plan,
  call: ToolCall,
): Effect.fn.Return<CallDecision> {
  const parsed = yield* Effect.result(plan.parse(call))
  if (Result.isFailure(parsed))
    return CallDecision.cases.Blocked.make({ reason: parsed.failure.message })
  if (plan.source === 'wait') return CallDecision.cases.Held.make({ kind: 'answer' })
  const approved = yield* Effect.result(
    Effect.try({
      try: () => plan.approval(parsed.success),
      catch: (cause) =>
        cause instanceof ToolApprovalUnsupported ||
        cause instanceof ToolApprovalFailed ||
        cause instanceof ToolApprovalContextUnavailable
          ? cause
          : new ToolApprovalFailed({ toolName: call.name, cause }),
    }),
  )
  if (Result.isFailure(approved))
    return CallDecision.cases.Blocked.make({ reason: approved.failure.message })
  return approved.success
    ? CallDecision.cases.Held.make({ kind: 'approval' })
    : CallDecision.cases.Free.make({})
})

/**
 * In-process wake-ups for waits on a settlement, keyed by conversation and hold.
 *
 * Only the wake-up lives here. A waiter always rereads the durable document after it wakes, so a
 * wake-up for the same key from another harness in this process is harmless.
 */
const wakers = new Map<string, Set<Deferred.Deferred<void>>>()

const wakeKey = (conversationId: ConversationId, callId: string) => `${conversationId}:${callId}`

/** Complete every local waiter; each one rereads Pi's document rather than trusting the notification. */
const wake = (key: string) =>
  Effect.forEach(
    Array.from(wakers.get(key) ?? []),
    (deferred) => Deferred.succeed(deferred, undefined),
    {
      discard: true,
    },
  )

/** Remove only this waiter's registration, including on interruption or snapshot failure. */
function unregister(key: string, deferred: Deferred.Deferred<void>) {
  const listeners = wakers.get(key)
  if (listeners === undefined) return
  listeners.delete(deferred)
  if (listeners.size === 0) wakers.delete(key)
}

/** Register before reading so a concurrent durable settlement cannot be lost between read and wait. */
const readSettlement = Effect.fn('Durable.readSettlement')(function* (
  api: HookApi,
  callId: string,
  context: Context,
) {
  const key = wakeKey(api.conversationId, holdIdOf(api.taskId))
  const woken = yield* Deferred.make<void>()
  return yield* Effect.gen(function* () {
    yield* Effect.sync(() => {
      const listeners = wakers.get(key) ?? new Set<Deferred.Deferred<void>>()
      listeners.add(woken)
      wakers.set(key, listeners)
    })
    const holds = yield* Pi.snapshot(api, Holds, api.conversationId, context)
    const live = yield* Pi.snapshot(api, LiveDoc, api.conversationId, context)
    const found = lookupSnapshots(
      live,
      holds,
      CallIdentity.cases.Task.make({ callId, taskId: api.taskId, resultTask: Option.none() }),
    )
    if (CallLookup.guards.Settled(found)) return Option.some(copySettlement(found.settlement))
    yield* Deferred.await(woken)
    return Option.none<Settlement>()
  }).pipe(Effect.ensuring(Effect.sync(() => unregister(key, woken))))
})

/**
 * Wait until call `callId` is settled, from inside a `beforeTool` hook.
 *
 * The hook runs before Pi Durable records the call's intent, and reruns after a restart, so this is
 * a durable wait built from a durable document and a volatile wake-up: the rerun reads the
 * settlement if it was committed while the process was down, and waits again if not.
 *
 * The wake-up is registered before the read. Registering after would lose a settlement committed
 * between the read and the registration.
 */
export const settlement = Effect.fn('Durable.settlement')(function* (
  api: HookApi,
  callId: string,
  context: Context,
) {
  for (;;) {
    const settled = yield* readSettlement(api, callId, context)
    if (Option.isSome(settled)) return settled.value
  }
})

/**
 * Validate the observed waiting task, then select the first settlement atomically with its live slot.
 * Concurrent decisions return detached copies; stale call ids cannot authorize a successor task.
 */
const settle = Effect.fn('Durable.settle')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: {
    readonly holdId: HoldId
    readonly next: Settlement
    readonly admission: Option.Option<readonly Waiting[]>
  },
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const identity = CallIdentity.cases.Hold.make({ holdId: input.holdId })
  const found = yield* readHold(harness, conversationId, identity, context)
  if (CallLookup.guards.Settled(found)) {
    if (!sameKind(found.settlement, input.next))
      return yield* new CallNotWaiting({ conversationId, holdId: input.holdId })
    return copySettlement(found.settlement)
  }
  if (!CallLookup.guards.Ready(found))
    return yield* new CallNotWaiting({ conversationId, holdId: input.holdId })
  // Arguments are absent from pending slots. Read the context once through waiting only for new
  // admission; repeats and the atomic revalidation need no transcript at all.
  const held = Option.isSome(input.admission)
    ? input.admission.value
    : yield* waiting(harness, conversationId, context)
  const kind = isAnswerSettlement(input.next) ? 'answer' : 'approval'
  const allowed = held.some((call) => call.holdId === input.holdId && call.kind === kind)
  if (!allowed) return yield* new CallNotWaiting({ conversationId, holdId: input.holdId })
  // Retain SDK identity beside the durable settlement, so removed definitions cannot rewrite history.
  const row = held.find((call) => call.holdId === input.holdId)
  const agent = yield* Pi.agent(conversation, context)
  const plan =
    row === undefined
      ? Option.none<Plan>()
      : Option.fromNullishOr(agent.tools.find((tool) => tool.name === row.toolName)).pipe(
          Option.flatMap(planOf),
        )
  const winner = yield* Pi.commitWithLive(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (document, live) => {
        const latest = lookup(live, document, identity)
        if (CallLookup.guards.Settled(latest))
          return sameKind(latest.settlement, input.next)
            ? Option.some(copySettlement(latest.settlement))
            : Option.none<Settlement>()
        if (!CallLookup.guards.Ready(latest)) return Option.none<Settlement>()
        const record: Settled = {
          taskId: latest.taskId,
          callId: latest.callId,
          settlement: copySettlement(input.next),
        }
        if (Option.isSome(plan))
          record.presentation = {
            dynamic: plan.value.dynamic,
            title: Option.getOrNull(plan.value.title),
          }
        document.settled[input.holdId] = record
        return Option.some(copySettlement(input.next))
      },
    },
    context,
  )
  if (Option.isNone(winner))
    return yield* new CallNotWaiting({ conversationId, holdId: input.holdId })
  yield* Effect.sync(() => harness.resume())
  yield* wake(wakeKey(conversationId, input.holdId))
  return winner.value
})

/** Both successful and failed client outputs settle an answer, never an approval. */
export const isAnswerSettlement = (value: Settlement): boolean =>
  value.kind === 'answered' || value.kind === 'errored'

/** A different kind of interaction cannot reuse another kind's receipt. */
const sameKind = (left: Settlement, right: Settlement) =>
  isAnswerSettlement(left) === isAnswerSettlement(right)

/** Direct admission starts with its durable hold id; no call-id provenance scan is needed. */
const readHold = Effect.fn('Durable.readHold')(function* (
  harness: Harness,
  conversationId: ConversationId,
  identity: typeof CallIdentity.cases.Hold.Type,
  context: Context,
) {
  const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  const holds = yield* Pi.snapshot(harness, Holds, conversationId, context)
  return lookupSnapshots(live, holds, identity)
})

/** A person's decision on a tool call that waits for approval. */
export type Decision = {
  readonly holdId: HoldId
  readonly approved: boolean
  /** Shown to the model when denied. */
  readonly reason?: string
}

/**
 * Approve or deny a tool call. Idempotent: the first decision for a call wins, and is returned.
 *
 * Works with no client attached and across a restart: the decision is committed to the
 * conversation, and the waiting call picks it up when the harness runs.
 */
export function decide(
  harness: Harness,
  conversationId: ConversationId,
  approval: Decision,
  context: Context,
): Effect.Effect<
  Settlement,
  CallNotWaiting | DurableErrors.PiFailed | DurableErrors.ConversationMissing
> {
  return settle(
    harness,
    conversationId,
    { holdId: approval.holdId, next: decisionSettlement(approval), admission: Option.none() },
    context,
  )
}

/** The result of a tool call that a person supplies. */
export type Answer = { readonly holdId: HoldId; readonly output: JsonValue }

/**
 * Supply the result of a tool call that has no server `execute`.
 *
 * A `wait` call is settled in place and the model continues from the tool result. A `later` call
 * already returned, so the answer is submitted as a new user message: a follow-up, which starts a
 * run when the conversation is idle and otherwise waits for the current answer. The request id contains
 * the hold and attempt, so a withdrawn follow-up can retry. The first output of each delivery attempt is reserved durably;
 * queued/placed repeats return it unchanged. Every successful answer returns its settlement.
 */
export const answer: (
  harness: Harness,
  conversationId: ConversationId,
  given: Answer,
  context: Context,
) => Effect.Effect<
  Settlement,
  | CallNotWaiting
  | DurableErrors.ConversationMissing
  | DurableErrors.PiFailed
  | DurableErrors.ToolOutputFailed
> = Effect.fn('Durable.answer')(function* (
  harness: Harness,
  conversationId: ConversationId,
  given: Answer,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const identity = CallIdentity.cases.Hold.make({ holdId: given.holdId })
  const found = yield* readHold(harness, conversationId, identity, context)
  if (CallLookup.guards.Settled(found)) {
    if (found.settlement.kind !== 'answered')
      return yield* new CallNotWaiting({ conversationId, holdId: given.holdId })
    return copySettlement(found.settlement)
  }
  if (!CallLookup.guards.Asked(found))
    return yield* settle(
      harness,
      conversationId,
      {
        holdId: given.holdId,
        next: { kind: 'answered', output: given.output },
        admission: Option.none(),
      },
      context,
    )
  return yield* deliver(harness, conversation, given, context)
})

/** HTTP batch admission reuses the one waiting observation; settle still validates the live task atomically. */
export function decideObserved(
  harness: Harness,
  conversationId: ConversationId,
  observed: { readonly decision: Decision; readonly held: readonly Waiting[] },
  context: Context,
): Effect.Effect<
  Settlement,
  CallNotWaiting | DurableErrors.PiFailed | DurableErrors.ConversationMissing
> {
  const { decision: approval } = observed
  return settle(
    harness,
    conversationId,
    {
      holdId: approval.holdId,
      next: decisionSettlement(approval),
      admission: Option.some(observed.held),
    },
    context,
  )
}

/** Client tool outputs can only answer wait holds from the batch's single observation. */
export function answerObserved(
  harness: Harness,
  conversationId: ConversationId,
  observed: { readonly given: Answer; readonly held: readonly Waiting[] },
  context: Context,
): Effect.Effect<
  Settlement,
  CallNotWaiting | DurableErrors.PiFailed | DurableErrors.ConversationMissing
> {
  return settle(
    harness,
    conversationId,
    {
      holdId: observed.given.holdId,
      next: { kind: 'answered', output: observed.given.output },
      admission: Option.some(observed.held),
    },
    context,
  )
}

/** Persist this fallback even when the person supplies no reason, preserving existing receipt presentation. */
const defaultDenialReason = 'The person denied this call'

/** Direct and batch admission share one decision-to-settlement rule and model-visible denial text. */
function decisionSettlement(approval: Decision): Settlement {
  return approval.approved
    ? { kind: 'approved' }
    : { kind: 'denied', reason: approval.reason ?? defaultDenialReason }
}

/** Error outputs use the same task-scoped first-writer admission as successful client outputs. */
export function errorObserved(
  harness: Harness,
  conversationId: ConversationId,
  observed: {
    readonly given: { readonly holdId: HoldId; readonly errorText: string }
    readonly held: readonly Waiting[]
  },
  context: Context,
): Effect.Effect<
  Settlement,
  CallNotWaiting | DurableErrors.PiFailed | DurableErrors.ConversationMissing
> {
  return settle(
    harness,
    conversationId,
    {
      holdId: observed.given.holdId,
      next: { kind: 'errored', errorText: observed.given.errorText },
      admission: Option.some(observed.held),
    },
    context,
  )
}
