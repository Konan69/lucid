import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type HookApi,
  type EntryRecord,
  type LiveState,
  LiveDoc,
  type TaskId,
  type ToolSlot,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Deferred, Effect, Match, Option, Predicate, Schema } from 'effect'

import * as Pi from './pi.ts'
import { CallNotWaiting } from './errors.ts'
import { waiting } from './waiting.ts'

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

/** A provider's call id may be reused; Pi's durable task id identifies the exact held invocation. */
export type Settled = { taskId: TaskId; settlement: Settlement }

/**
 * Durable hold state of one conversation.
 *
 * `settled` records the owning Pi task so reused provider call ids never inherit approval.
 * `asked` lists the calls of answer-later tools that already
 * returned to the model and still expect an answer, with the tool's name for the message that
 * delivers it. Latest-only: a hold belongs to a run in progress, never to a rewound transcript.
 */
export const Holds = defineDoc<{
  settled: Record<string, Settled>
  asked: Record<string, { taskId: TaskId; toolName: string }>
}>({
  kind: 'durable.holds',
  version: 3,
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
])

/** Hooks address their exact task; public calls require unique ids and completed-entry provenance. */
export const CallIdentity = Schema.TaggedUnion({
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
  Ready: { taskId: TaskIdentity },
  Executing: { taskId: TaskIdentity },
  Done: { taskId: TaskIdentity },
  Settled: { taskId: TaskIdentity, settlement: SettlementValue },
  Asked: { taskId: TaskIdentity, toolName: Schema.String },
})
export type CallLookup = typeof CallLookup.Type

type HoldState = {
  settled: Record<string, Settled>
  asked: Record<string, { taskId: TaskId; toolName: string }>
}

/** The newest assistant entry owns the call; an older run's result is never evidence for a new invocation. */
export function identify(entries: readonly EntryRecord[], callId: string) {
  const at = entries.findLastIndex((entry) => callsIn(entry, callId).length > 0)
  if (at === -1)
    return CallIdentity.cases.Public.make({ callId, resultTask: Option.none(), duplicate: false })
  const owner = entries[at]
  const duplicate = owner !== undefined && callsIn(owner, callId).length > 1
  const result = entries.slice(at + 1).find((entry) => {
    const messages = entry.model
    return (
      messages !== undefined &&
      messages.some((message) => message.role === 'toolResult' && message.toolCallId === callId)
    )
  })
  return CallIdentity.cases.Public.make({
    callId,
    duplicate,
    resultTask: Option.fromNullishOr(result).pipe(
      Option.flatMapNullishOr((entry) => entry.byTaskId),
    ),
  })
}

/** The SDK's transcript is typed; select calls without flattening duplicate ids into a Map. */
export function callsIn(entry: EntryRecord, callId: string) {
  const messages = entry.model
  if (messages === undefined) return []
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.filter(
          (block): block is Extract<typeof block, { type: 'toolCall' }> =>
            block.type === 'toolCall' && block.id === callId,
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
  const recorded = holds.settled[callId]
  if (recorded !== undefined && recorded.taskId === taskId)
    return CallLookup.cases.Settled.make({
      taskId,
      settlement: copySettlement(recorded.settlement),
    })
  const asked = holds.asked[callId]
  if (asked !== undefined && asked.taskId === taskId)
    return CallLookup.cases.Asked.make({ taskId, toolName: asked.toolName })
  return Match.value(slot.status).pipe(
    Match.when('pending', () => CallLookup.cases.Ready.make({ taskId })),
    Match.when('running', () => CallLookup.cases.Executing.make({ taskId })),
    Match.when('done', () => CallLookup.cases.Done.make({ taskId })),
    Match.exhaustive,
  )
}

/**
 * The sole safety lookup. A live id must be unique; a hook selects its slot by taskId. With no slot,
 * only the newest call's tool-result byTaskId can validate a settlement. In-flight generation calls
 * have no task yet and cannot inherit a prior run's settlement even before their slots are created.
 */
export function lookup(
  live: Readonly<LiveState>,
  holds: Readonly<HoldState>,
  identity: CallIdentity,
): CallLookup {
  const slots = live.tools ?? []
  const matching = slots.filter((slot) => slot.callId === identity.callId)
  if (matching.length > 1) return CallLookup.cases.Duplicate.make({})
  const slot = CallIdentity.match(identity, {
    Public: () => Option.fromNullishOr(matching[0]),
    Task: (task) =>
      Option.fromNullishOr(
        slots.find(
          (candidate) => candidate.taskId === task.taskId && candidate.callId === task.callId,
        ),
      ),
  })
  if (Option.isSome(slot)) return taskState(holds, identity.callId, slot.value)
  if (matching.length > 0) return CallLookup.cases.Missing.make({})
  const generation = live.generation
  if (
    generation !== undefined &&
    generation.message !== undefined &&
    generation.message.content.some(
      (block) => block.type === 'toolCall' && block.id === identity.callId,
    )
  )
    return CallLookup.cases.Queued.make({})
  return CallIdentity.match(identity, {
    Public: (call) =>
      call.duplicate
        ? CallLookup.cases.Duplicate.make({})
        : Option.match(call.resultTask, {
            onNone: () => CallLookup.cases.Missing.make({}),
            onSome: (taskId) => taskState(holds, call.callId, { taskId, status: 'done' }),
          }),
    Task: (task) =>
      Option.contains(task.resultTask, task.taskId)
        ? taskState(holds, task.callId, { taskId: task.taskId, status: 'done' })
        : CallLookup.cases.Missing.make({}),
  })
}

/** Normalize genuine document absence to Pi's declared initial value, then use the same pure lookup. */
export function lookupSnapshots(
  live: Option.Option<Readonly<LiveState>>,
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
  readonly approval: (input: JsonValue) => boolean
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

/** What a call waits for under its plan; None means the tool executes without a hold. */
export function holdKind(plan: Plan, input: JsonValue): Option.Option<'approval' | 'answer'> {
  if (plan.source === 'wait') return Option.some('answer')
  return plan.approval(input) ? Option.some('approval') : Option.none()
}

/**
 * In-process wake-ups for waits on a settlement, keyed by conversation and call.
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
  const key = wakeKey(api.conversationId, callId)
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
  input: { readonly callId: string; readonly next: Settlement },
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const observed = yield* readCall(harness, conversation, input.callId, context)
  const held = yield* waiting(harness, conversationId, context)
  const kind = input.next.kind === 'answered' ? 'answer' : 'approval'
  const allowed = held.some((call) => call.callId === input.callId && call.kind === kind)
  const identity = CallLookup.guards.Ready(observed.found)
    ? CallIdentity.cases.Task.make({
        callId: input.callId,
        taskId: observed.found.taskId,
        resultTask: observed.identity.resultTask,
      })
    : observed.identity
  const winner = yield* Pi.commitWithLive(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (holds, live) => {
        const found = lookup(live, holds, identity)
        if (CallLookup.guards.Settled(found)) return Option.some(copySettlement(found.settlement))
        if (!allowed || !CallLookup.guards.Ready(found)) return Option.none<Settlement>()
        holds.settled[input.callId] = {
          taskId: found.taskId,
          settlement: copySettlement(input.next),
        }
        return Option.some(copySettlement(input.next))
      },
    },
    context,
  )
  if (Option.isNone(winner)) {
    // A concurrent winner can finish before our commit. Reread its result provenance once;
    // this is idempotency validation, never a retry that authorizes a different task.
    const current = yield* readCall(harness, conversation, input.callId, context)
    const found = lookup(
      current.live,
      current.holds,
      CallIdentity.match(identity, {
        Public: (): CallIdentity => current.identity,
        Task: (task): CallIdentity =>
          CallIdentity.cases.Task.make({
            callId: task.callId,
            taskId: task.taskId,
            resultTask: current.identity.resultTask,
          }),
      }),
    )
    if (CallLookup.guards.Settled(found)) return copySettlement(found.settlement)
    return yield* new CallNotWaiting({ conversationId, callId: input.callId })
  }
  yield* Effect.sync(() => harness.resume())
  yield* wake(wakeKey(conversationId, input.callId))
  return winner.value
})

/** A person's decision on a tool call that waits for approval. */
export type Decision = {
  readonly callId: string
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
  decision: Decision,
  context: Context,
) {
  const next: Settlement = decision.approved
    ? { kind: 'approved' }
    : { kind: 'denied', reason: decision.reason ?? 'The person denied this call' }
  return settle(harness, conversationId, { callId: decision.callId, next }, context)
}

/** The result of a tool call that a person supplies. */
export type Answer = { readonly callId: string; readonly output: JsonValue }

/** The message that delivers a late answer to the model. */
const answerText = (toolName: string, output: JsonValue) =>
  `[answer to ${toolName}] ${Predicate.isString(output) ? output : JSON.stringify(output)}`

/**
 * Supply the result of a tool call that has no server `execute`.
 *
 * A `wait` call is settled in place and the model continues from the tool result. A `later` call
 * already returned, so the answer is submitted as a new user message: a follow-up, which starts a
 * run when the conversation is idle and otherwise waits for the current answer. The request id is
 * the call id, so answering twice delivers once.
 */
export const answer = Effect.fn('Durable.answer')(function* (
  harness: Harness,
  conversationId: ConversationId,
  given: Answer,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const current = yield* readCall(harness, conversation, given.callId, context)
  const found = current.found
  if (CallLookup.guards.Settled(found)) return copySettlement(found.settlement)
  if (!CallLookup.guards.Asked(found))
    return yield* settle(
      harness,
      conversationId,
      {
        callId: given.callId,
        next: { kind: 'answered', output: given.output },
      },
      context,
    )
  const identity = CallIdentity.cases.Task.make({
    callId: given.callId,
    taskId: found.taskId,
    resultTask: current.identity.resultTask,
  })
  yield* Pi.submit(
    conversation,
    {
      type: 'input',
      content: answerText(found.toolName, given.output),
      requestId: `answer:${given.callId}`,
      whenBusy: 'followUp',
    },
    context,
  )
  // Delete only after admission: a crash leaves the question open and retry deduplicates the input.
  yield* Pi.commitWithLive(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (document, live) => {
        const latest = lookup(live, document, identity)
        if (!CallLookup.guards.Asked(latest)) return
        document.settled[given.callId] = {
          taskId: latest.taskId,
          settlement: { kind: 'answered', output: copyJson(given.output) },
        }
        delete document.asked[given.callId]
      },
    },
    context,
  )
  return undefined
})

/** Resolve current provenance once for public admission; the serialized mutation revalidates it. */
const readCall = Effect.fn('Durable.readCall')(function* (
  harness: Harness,
  conversation: import('@earendil-works/pi-durable').Conversation,
  callId: string,
  context: Context,
) {
  const live = Option.getOrElse(
    yield* Pi.snapshot(harness, LiveDoc, conversation.id, context),
    () => LiveDoc.definition.initial(),
  )
  const holds = Option.getOrElse(yield* Pi.snapshot(harness, Holds, conversation.id, context), () =>
    Holds.definition.initial(),
  )
  const view = yield* Pi.view(conversation, context)
  const identity = identify(view.entries, callId)
  return { live, holds, identity, found: lookup(live, holds, identity) }
})
