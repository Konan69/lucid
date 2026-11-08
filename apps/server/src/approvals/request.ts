import { Array as Arr, Effect, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { answeredRuns } from '../inputs/answers.ts'
import { readConversationHistory, textOf } from '../runtime/history.ts'
import type { RuntimeService } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { REQUEST_RUNS, requestRuns, type RequestRun } from '../threads/runs.ts'

/**
 * The most text of the turn in progress the reviewer is given. The request is never cut: a cut
 * can remove the condition on it ("only after legal approves"), wherever in the message it sits,
 * and what is left would read as an unconditional request. A longer turn is not reviewed at
 * all, and `policy.ts` decides what an unreviewed action does. 16,000 characters with the 12,000 allowed for arguments (`review.ts`) stays
 * under the 48,000-byte request bound VCOS settled on for Jev
 * (`apps/web/src/agent/execute/routing/jev.ts` `MAX_REQUEST_BYTES`).
 */
export const REQUEST_CHARACTERS = 16_000

/**
 * The message before the turn is background, never authorization, so it is simply left out when
 * it is longer than this. 4,000 is the per-message limit in docs/22 "The trust loop", from Grok
 * Bot's Auto-review context limits.
 */
export const EARLIER_CHARACTERS = 4000

/**
 * What the acting Person asked for, as the reviewer of a proposed action is shown it.
 *
 * `request` is everything they said in the turn Vivid is working on now, whole. `earlier` is
 * their message before that turn, kept apart because it may already have been carried out: it
 * explains what "send it" or "yes" refers to, and must not by itself authorize a new action.
 */
export interface PersonRequest {
  readonly request: Arr.NonEmptyReadonlyArray<string>
  readonly earlier: Option.Option<string>
}

type History = Effect.Success<ReturnType<typeof readConversationHistory>>
type Message = History['messages'][number]

/** The tag of a signal delivery; a private Thread's plain user turn has none. */
const signalOf = (message: Message) =>
  message.purpose === 'dispatch' && message.signal !== undefined
    ? Option.fromUndefinedOr(message.signal.tagName)
    : Option.none<string>()

/**
 * Whether one history message is the acting Person's own instruction, given why its Run started.
 *
 * - `Message`: what they typed, a plain user turn in a private Thread or a `message` signal in a
 *   shared one.
 * - `Decision`: an `answer` to one of Vivid's questions, and only when the Input request records
 *   this Person as the one who answered (`inputs/answers.ts`). An `approval` signal is a decision
 *   about another action; it is never a request and never revives an earlier one, because the
 *   Approval does not record which request its action belonged to.
 * - `Watch`: not trusted: Vivid can create a Watch and write its instruction, and
 *   the event it carries is an outside app's text.
 * - `ChildResult`: not trusted: a helper's answer is model text and may quote pages it read.
 */
const spoken = (run: RequestRun, message: Message, answered: ReadonlySet<string>) => {
  const tag = signalOf(message)
  return StoredRunOrigin.match(run.origin, {
    Message: () => message.purpose === 'user' || Option.contains(tag, 'message'),
    Decision: () => Option.contains(tag, 'answer') && answered.has(run.id),
    FirstConversation: () => false,
    Watch: () => false,
    WatchUnrecorded: () => false,
    // The forget's instruction is the server's own text about a Settings press, not words said.
    Forget: () => false,
    ChildResult: () => false,
  })
}

interface Said {
  readonly current: boolean
  readonly text: string
}

/**
 * Every instruction in the history that a recorded Run attributes to the acting Person.
 *
 * A Run is the turn in progress only while its row says `working` and the runtime has not settled it.
 * The row alone is not enough: when writing a settlement fails, the row stays `working`
 * (`threads/delivery.ts`), and words that were already acted on would keep counting as current.
 */
const saidBy = (
  history: History,
  runs: ReadonlyArray<RequestRun>,
  answered: ReadonlySet<string>,
) => {
  const mine = new Map<string, RequestRun>(runs.map((run) => [run.id, run]))
  const settled = new Set(history.settlements.map((settlement) => settlement.runId))
  return history.messages.flatMap((message): ReadonlyArray<Said> => {
    const run = message.runId === undefined ? undefined : mine.get(message.runId)
    if (run === undefined || !spoken(run, message, answered)) return []
    const text = textOf(message).trim()
    return text.length === 0 ? [] : [{ current: run.working && !settled.has(run.id), text }]
  })
}

/**
 * Splits what was said into the turn in progress and the message before it. `None` when the
 * Person said nothing in the turn in progress, or said more than can be shown whole.
 */
const split = (said: ReadonlyArray<Said>): Option.Option<PersonRequest> => {
  const request = said.flatMap((entry) => (entry.current ? [entry.text] : []))
  const length = request.reduce((total, text) => total + text.length, 0)
  if (!Arr.isReadonlyArrayNonEmpty(request) || length > REQUEST_CHARACTERS) return Option.none()
  const before = said.flatMap((entry) => (entry.current ? [] : [entry.text]))
  return Option.some({
    request,
    earlier: Option.filter(Arr.last(before), (text) => text.length <= EARLIER_CHARACTERS),
  })
}

/**
 * What the acting Person asked for, in their own words, for the reviewer of a proposed action.
 *
 * The working model's summary of the request cannot vouch for itself. Conversation history has the
 * words and the server's records have the attribution: a history message
 * counts only when its submission is a Run recorded as acting for the acting Person
 * (`threads/runs.ts`) and that Person wrote it (`spoken`). Names in the conversation are never
 * compared.
 *
 * `None` means there is no request to judge against: no Thread, nothing the Person said in the
 * turn in progress, more than can be shown whole, or the read failed or passed five seconds. It
 * never fails; the action is then unreviewed (`policy.ts`).
 */
export const personRequest = Effect.fn('Review.personRequest')(
  function* (runtime: Pick<RuntimeService, 'read'>, actor: Actor) {
    if (Option.isNone(actor.threadId)) return Option.none<PersonRequest>()
    const threadId = actor.threadId.value
    const runs = yield* requestRuns(threadId, actor.person.id)
    if (!runs.some((run) => run.working)) return Option.none<PersonRequest>()
    // A full window whose oldest Run is still working may have cut the turn's first messages
    // off, and a condition set there with them. An incomplete request is not a request.
    if (runs.length === REQUEST_RUNS && Option.exists(Arr.head(runs), (run) => run.working))
      return Option.none<PersonRequest>()
    const answered = yield* answeredRuns(threadId, actor.person.id)
    const history = yield* readConversationHistory(runtime, threadId)
    return split(saidBy(history, runs, answered))
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
