import type { Context, JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type HookApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Deferred, Effect, Option, Predicate } from 'effect'

import * as Pi from './pi.ts'

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

/**
 * Durable hold state of one conversation.
 *
 * `settled` is keyed by tool call id. `asked` lists the calls of answer-later tools that already
 * returned to the model and still expect an answer, with the tool's name for the message that
 * delivers it. Latest-only: a hold belongs to a run in progress, never to a rewound transcript.
 */
export const Holds = defineDoc<{
  settled: Record<string, Settlement>
  asked: Record<string, string>
}>({
  kind: 'durable.holds',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ settled: {}, asked: {} }),
})

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
  readonly approval: (input: unknown) => boolean
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
export function holdKind(plan: Plan, input: unknown): Option.Option<'approval' | 'answer'> {
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
  Effect.forEach(wakers.get(key) ?? [], (deferred) => Deferred.succeed(deferred, undefined), {
    discard: true,
  })

/** Remove only this waiter's registration, including on interruption or snapshot failure. */
function unregister(key: string, deferred: Deferred.Deferred<void>) {
  const waiting = wakers.get(key)
  if (waiting === undefined) return
  waiting.delete(deferred)
  if (waiting.size === 0) wakers.delete(key)
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
      const waiting = wakers.get(key) ?? new Set<Deferred.Deferred<void>>()
      waiting.add(woken)
      wakers.set(key, waiting)
    })
    const holds = yield* Pi.snapshot(api, Holds, api.conversationId, context)
    const settled = holds.pipe(Option.flatMapNullishOr((document) => document.settled[callId]))
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

/** First settlement wins inside Pi's serialized commit, then the harness and local waiters resume. */
const settle = Effect.fn('Durable.settle')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: { readonly callId: string; readonly next: Settlement },
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const winner = yield* Pi.commit(
    conversation,
    {
      token: Holds,
      conversationId,
      change: (holds) => {
        const existing = holds.settled[input.callId]
        if (existing !== undefined) return existing
        holds.settled[input.callId] = input.next
        return input.next
      },
    },
    context,
  )
  yield* Effect.sync(() => harness.resume())
  yield* wake(wakeKey(conversationId, input.callId))
  return winner
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
    yield* settle(
      harness,
      conversationId,
      {
        callId: given.callId,
        next: { kind: 'answered', output: given.output },
      },
      context,
    )
    return
  }
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
        delete document.asked[given.callId]
      },
    },
    context,
  )
})
