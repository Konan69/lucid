import { Array as Arr, Effect, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { readConversationHistory, textOf } from '../memory/history.ts'
import { instructionOf } from '../routines/scheduler.ts'
import type { RuntimeService } from '../runtime/client.ts'
import { findThread } from '../threads/access.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { requestRuns, type RequestRun } from '../threads/runs.ts'

/**
 * One message is shown to the reviewer in at most 4,000 characters (docs/22 "The trust loop",
 * from Grok Bot's Auto-review context limits). A longer one keeps its first and last 2,000: a
 * request is normally stated at the start, and a condition on it ("do not send yet") at the end,
 * so cutting only the tail could turn a conditional request into an unconditional one. Unproved
 * against the reference: which part Grok Bot keeps.
 */
export const REQUEST_CHARACTERS = 4000
const ELIDED = '\n[…]\n'

/**
 * How many messages of the turn in progress are kept. A Person can send several while Vivid
 * works and each joins the working turn; the newest six are kept so a late message cannot push
 * the instruction that started the turn out of view. The number is Vivid's own choice.
 */
export const REQUEST_MESSAGES = 6

/**
 * What the acting Person asked for, as the reviewer of a proposed action is shown it.
 *
 * `request` is what they said in the turn Vivid is working on now. `earlier` is their message
 * before that turn, kept apart because it may already have been carried out: it explains what
 * "send it" or "yes" refers to, and must not by itself authorize a new action.
 */
export interface PersonRequest {
  readonly request: Arr.NonEmptyReadonlyArray<string>
  readonly earlier: Option.Option<string>
}

type History = Effect.Success<ReturnType<typeof readConversationHistory>>
type Message = History['messages'][number]

const bounded = (text: string) =>
  text.length <= REQUEST_CHARACTERS
    ? text
    : `${text.slice(0, REQUEST_CHARACTERS / 2)}${ELIDED}${text.slice(-REQUEST_CHARACTERS / 2)}`

/** The tag of a signal delivery; a private Thread's plain user turn has none. */
const signalOf = (message: Message) =>
  message.purpose === 'dispatch' && message.signal !== undefined
    ? Option.fromUndefinedOr(message.signal.tagName)
    : Option.none<string>()

/**
 * The Person's own instruction in one history message, given why its Run started.
 *
 * - `Message`: what they typed, a plain user turn in a private Thread or a `message` signal in a
 *   shared one.
 * - `Decision`: an `answer` to one of Vivid's questions, and only in a private Thread. In a
 *   shared Thread another member may answer a question addressed to this Person, and the Run
 *   record keeps whose authority continues, not who spoke (`approvals/replay.ts`). An `approval`
 *   signal is a decision about another action and is never a request.
 * - `Routine`: the instruction the Person set up, without the outside payload appended to it
 *   (`routines/scheduler.ts#instructionOf`). docs/22: "The Routine's own instruction is trusted
 *   context for the reviewer."
 * - `Standing`, `Attention`, `FirstConversation`: the server or Vivid wrote the body. Never.
 */
const spoken = (run: RequestRun, message: Message, privateThread: boolean) => {
  const tag = signalOf(message)
  const said = (accepted: boolean) =>
    accepted ? Option.some(textOf(message).trim()) : Option.none<string>()
  return StoredRunOrigin.match(run.origin, {
    Message: () => said(message.purpose === 'user' || Option.contains(tag, 'message')),
    Decision: () => said(privateThread && Option.contains(tag, 'answer')),
    Routine: () => Option.map(said(Option.contains(tag, 'schedule')), instructionOf),
    Standing: () => Option.none<string>(),
    Attention: () => Option.none<string>(),
    FirstConversation: () => Option.none<string>(),
  })
}

interface Said {
  readonly working: boolean
  readonly text: string
}

/** Every instruction in the history that a recorded Run attributes to the acting Person. */
const saidBy = (history: History, runs: ReadonlyArray<RequestRun>, privateThread: boolean) => {
  const mine = new Map<string, RequestRun>(runs.map((run) => [run.id, run]))
  return history.messages.flatMap((message): ReadonlyArray<Said> => {
    const run = message.submissionId === undefined ? undefined : mine.get(message.submissionId)
    if (run === undefined) return []
    const text = Option.filter(spoken(run, message, privateThread), (words) => words.length > 0)
    return Option.match(text, {
      onNone: () => [],
      onSome: (words) => [{ working: run.working, text: bounded(words) }],
    })
  })
}

/**
 * Splits what was said into the turn in progress and the message before it.
 *
 * A turn continued by a decision (the Person allowed an earlier action, or somebody answered in a
 * shared Thread) has no words of its own. Its request is then the Person's last message: that is
 * the work the decision let Vivid resume. No other turn borrows an earlier message, so a Routine
 * or a check Vivid started cannot inherit authority from something the Person said days before.
 */
const split = (said: ReadonlyArray<Said>, runs: ReadonlyArray<RequestRun>) => {
  const before = said.flatMap((entry) => (entry.working ? [] : [entry.text]))
  const now = said.flatMap((entry) => (entry.working ? [entry.text] : []))
  const current = now.slice(-REQUEST_MESSAGES)
  if (Arr.isReadonlyArrayNonEmpty(current))
    return Option.some<PersonRequest>({ request: current, earlier: Arr.last(before) })
  const resumed = runs.some((run) => run.working && StoredRunOrigin.guards.Decision(run.origin))
  return Option.map(resumed ? Arr.last(before) : Option.none<string>(), (last): PersonRequest => ({
    request: [last],
    earlier: Option.none(),
  }))
}

/**
 * What the acting Person asked for, in their own words, for the reviewer of a proposed action.
 *
 * The working model's summary of the request cannot vouch for itself. Flue's history has the
 * words and the Run record has the attribution Flue does not keep (`threads/runs.ts`): a history
 * message counts only when its submission is a Run this server recorded as acting for the acting
 * Person, and only the part of it that Person wrote (`spoken`). Names in the conversation are
 * never compared.
 *
 * `None` means there is no request to judge against: no Thread, nothing said in the turn in
 * progress, or the read failed or passed five seconds. It never fails; the gate then asks.
 */
export const personRequest = Effect.fn('Review.personRequest')(
  function* (runtime: Pick<RuntimeService, 'read'>, actor: Actor) {
    if (Option.isNone(actor.threadId)) return Option.none<PersonRequest>()
    const threadId = actor.threadId.value
    const thread = yield* findThread(threadId)
    if (Option.isNone(thread)) return Option.none<PersonRequest>()
    const runs = yield* requestRuns(threadId, actor.person.id)
    if (!runs.some((run) => run.working)) return Option.none<PersonRequest>()
    const history = yield* readConversationHistory(runtime, threadId)
    return split(saidBy(history, runs, thread.value.audience === 'private'), runs)
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout('5 seconds'),
      Effect.catch((error) =>
        Effect.logWarning('Review request unavailable', { tag: error._tag }).pipe(
          Effect.as(Option.none<PersonRequest>()),
        ),
      ),
    ),
)
