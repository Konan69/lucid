import type { Context, JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  defineDoc,
  type Harness,
  type HookApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable'

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

/** The plan of a tool registered through the bridge; `undefined` for any other Pi Durable tool. */
export const planOf = (tool: ToolRegistration): Plan | undefined => (tool as Planned)[planned]

/** What a call waits for under `plan`, given its input. `undefined`: it does not wait. */
export function holdKind(plan: Plan, input: unknown): 'approval' | 'answer' | undefined {
  if (plan.source === 'wait') return 'answer'
  return plan.approval(input) ? 'approval' : undefined
}

/**
 * In-process wake-ups for waits on a settlement, keyed by conversation and call.
 *
 * Only the wake-up lives here. A waiter always rereads the durable document after it wakes, so a
 * wake-up for the same key from another harness in this process is harmless.
 */
const wakers = new Map<string, Set<() => void>>()

const wakeKey = (conversationId: ConversationId, callId: string) => `${conversationId}:${callId}`

/** Resolves at the next `wake` of `key`; rejects when `signal` aborts first. */
function nextWake(key: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiting = wakers.get(key) ?? new Set()
    wakers.set(key, waiting)
    const done = () => {
      waiting.delete(done)
      if (waiting.size === 0) wakers.delete(key)
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const aborted = () => {
      waiting.delete(done)
      if (waiting.size === 0) wakers.delete(key)
      reject(signal?.reason)
    }
    waiting.add(done)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function wake(key: string) {
  for (const done of [...(wakers.get(key) ?? [])]) done()
}

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
export async function settlement(
  api: HookApi,
  callId: string,
  context: Context,
): Promise<Settlement> {
  const key = wakeKey(api.conversationId, callId)
  for (;;) {
    const woken = nextWake(key, context.abortSignal)
    // Observed even when the settlement is already there and the wake-up is never awaited.
    woken.catch(() => {})
    const holds = await api.snapshot(Holds, api.conversationId, context)
    const settled = holds?.settled[callId]
    if (settled !== undefined) return settled
    await woken
  }
}

/** Record `next` for `callId` unless it is already settled. The first settlement wins and is returned. */
async function settle(
  harness: Harness,
  conversationId: ConversationId,
  callId: string,
  next: Settlement,
  context: Context,
): Promise<Settlement> {
  const conversation = await harness.conversation(conversationId, context)
  if (conversation === undefined) throw new Error(`Conversation ${conversationId} does not exist`)
  const winner = await conversation.commit(async (tx) => {
    const holds = await tx.doc(Holds, conversationId)
    const existing = holds.settled[callId]
    if (existing !== undefined) return existing
    holds.settled[callId] = next
    return next
  }, context)
  // The tool task that waits is only scheduled while the harness runs.
  harness.resume()
  wake(wakeKey(conversationId, callId))
  return winner
}

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
): Promise<Settlement> {
  const next: Settlement = decision.approved
    ? { kind: 'approved' }
    : { kind: 'denied', reason: decision.reason ?? 'The person denied this call' }
  return settle(harness, conversationId, decision.callId, next, context)
}

/** The result of a tool call that a person supplies. */
export type Answer = { readonly callId: string; readonly output: JsonValue }

/** The message that delivers a late answer to the model. */
const answerText = (toolName: string, output: JsonValue) =>
  `[answer to ${toolName}] ${typeof output === 'string' ? output : JSON.stringify(output)}`

/**
 * Supply the result of a tool call that has no server `execute`.
 *
 * A `wait` call is settled in place and the model continues from the tool result. A `later` call
 * already returned, so the answer is submitted as a new user message: a follow-up, which starts a
 * run when the conversation is idle and otherwise waits for the current answer. The request id is
 * the call id, so answering twice delivers once.
 */
export async function answer(
  harness: Harness,
  conversationId: ConversationId,
  given: Answer,
  context: Context,
): Promise<void> {
  const conversation = await harness.conversation(conversationId, context)
  if (conversation === undefined) throw new Error(`Conversation ${conversationId} does not exist`)
  const holds = await harness.snapshot(Holds, conversationId, context)
  const toolName = holds?.asked[given.callId]
  if (toolName === undefined) {
    await settle(
      harness,
      conversationId,
      given.callId,
      { kind: 'answered', output: given.output },
      context,
    )
    return
  }
  await conversation.submit(
    {
      type: 'input',
      content: answerText(toolName, given.output),
      requestId: `answer:${given.callId}`,
      whenBusy: 'followUp',
    },
    context,
  )
  // After the submission, so a crash between the two leaves the question open and a repeated
  // answer is deduplicated by its request id.
  await conversation.commit(async (tx) => {
    delete (await tx.doc(Holds, conversationId)).asked[given.callId]
  }, context)
}
