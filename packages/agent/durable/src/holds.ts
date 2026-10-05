import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type HookApi,
  type LiveState,
  LiveDoc,
  type TaskId,
  type ToolSlot,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Deferred, Effect, Match, Option, Predicate } from 'effect'

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
  asked: Record<string, string>
}>({
  kind: 'durable.holds',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ settled: {}, asked: {} }),
})

/**
 * One settlement lookup for hooks, waiting views, streaming, and admission. A pending slot of a
 * different task invalidates the record. Once the slot is no longer pending, retain the decision
 * for idempotent retries and denied display. Always detach Pi transaction overlays before returning.
 */
export function applicable(
  record: Option.Option<Settled>,
  slot: Option.Option<Readonly<ToolSlot>>,
) {
  if (Option.isNone(record)) return Option.none<Settlement>()
  if (
    Option.isSome(slot) &&
    slot.value.status === 'pending' &&
    slot.value.taskId !== record.value.taskId
  )
    return Option.none<Settlement>()
  return Option.some(copySettlement(record.value.settlement))
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

/** A live slot is absent between tool rounds; preserve that absence for the settlement rule. */
export function slotOf(live: Readonly<LiveState>, callId: string) {
  const tools = live.tools
  return tools === undefined
    ? Option.none<ToolSlot>()
    : Option.fromNullishOr(tools.find((candidate) => candidate.callId === callId))
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
    const slot = live.pipe(Option.flatMap((document) => slotOf(document, callId)))
    const settled = applicable(
      holds.pipe(Option.flatMapNullishOr((document) => document.settled[callId])),
      slot,
    )
    if (Option.isSome(settled)) return settled
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
  const observed = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  const task = observed.pipe(
    Option.flatMap((live) => slotOf(live, input.callId)),
    Option.flatMapNullishOr((slot) => slot.taskId),
  )
  const held = yield* waiting(harness, conversationId, context)
  const kind = input.next.kind === 'answered' ? 'answer' : 'approval'
  const allowed = held.some((call) => call.callId === input.callId && call.kind === kind)
  const winner = yield* Pi.commitWithLive(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (holds, live) => {
        const slot = slotOf(live, input.callId)
        const existing = applicable(Option.fromNullishOr(holds.settled[input.callId]), slot)
        if (Option.isSome(existing)) return existing
        if (
          !allowed ||
          Option.isNone(task) ||
          Option.isNone(slot) ||
          slot.value.status !== 'pending' ||
          slot.value.taskId !== task.value
        )
          return Option.none<Settlement>()
        holds.settled[input.callId] = { taskId: task.value, settlement: copySettlement(input.next) }
        return Option.some(copySettlement(input.next))
      },
    },
    context,
  )
  if (Option.isNone(winner))
    return yield* new CallNotWaiting({ conversationId, callId: input.callId })
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
  const holds = yield* Pi.snapshot(harness, Holds, conversationId, context)
  const toolName = holds.pipe(Option.flatMapNullishOr((document) => document.asked[given.callId]))
  if (Option.isNone(toolName)) {
    return yield* settle(
      harness,
      conversationId,
      {
        callId: given.callId,
        next: { kind: 'answered', output: given.output },
      },
      context,
    )
  }
  const taskId = yield* lateTask(harness, conversation, given.callId, context)
  yield* Pi.submit(
    conversation,
    {
      type: 'input',
      content: answerText(toolName.value, given.output),
      requestId: `answer:${given.callId}`,
      whenBusy: 'followUp',
    },
    context,
  )
  // Delete only after admission: a crash leaves the question open and retry deduplicates the input.
  yield* Pi.commit(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (document) => {
        const recorded = Option.fromNullishOr(document.settled[given.callId])
        if (Option.isNone(recorded) || recorded.value.taskId !== taskId)
          document.settled[given.callId] = {
            taskId,
            settlement: { kind: 'answered', output: copyJson(given.output) },
          }
        delete document.asked[given.callId]
      },
    },
    context,
  )
  return undefined
})

/** A later answer retains the task from its live slot or committed tool result for idempotent retries. */
const lateTask = Effect.fn('Durable.lateAnswerTask')(function* (
  harness: Harness,
  conversation: import('@earendil-works/pi-durable').Conversation,
  callId: string,
  context: Context,
) {
  const live = yield* Pi.snapshot(harness, LiveDoc, conversation.id, context)
  const task = live.pipe(
    Option.flatMap((document) => slotOf(document, callId)),
    Option.flatMapNullishOr((slot) => slot.taskId),
  )
  if (Option.isSome(task)) return task.value
  const view = yield* Pi.view(conversation, context)
  const entry = view.entries.findLast((candidate) => {
    const model = candidate.model
    return (
      model !== undefined &&
      model.some((message) => message.role === 'toolResult' && message.toolCallId === callId)
    )
  })
  if (entry === undefined || entry.byTaskId === undefined)
    return yield* new CallNotWaiting({ conversationId: conversation.id, callId })
  return entry.byTaskId
})
