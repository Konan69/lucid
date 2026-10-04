import { Array as Arr, Effect, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { readConversationHistory, textOf } from '../memory/history.ts'
import type { RuntimeService } from '../runtime/client.ts'
import type { RunStoreService } from '../threads/runs.ts'

/**
 * How much of the Thread the reviewer is shown: the acting Person's last two messages, 4,000
 * characters each. The numbers are docs/22 "The trust loop" step 5, taken from Grok Bot's
 * Auto-review context limits. Unproved against the reference: whether it keeps the head or the
 * tail of a longer message. Vivid keeps the head, where a request is normally stated.
 */
export const REQUEST_MESSAGES = 2
export const REQUEST_CHARACTERS = 4000

/**
 * The deliveries whose body is the acting Person's own instruction: a shared-Thread message, a
 * pressed or typed answer to one of Vivid's questions, and a Routine's instruction as that Person
 * wrote it (docs/22: "The Routine's own instruction is trusted context for the reviewer"). An
 * `approval` signal is a decision about another action, not a request, so it is left out.
 */
const SPOKEN = new Set(['message', 'answer', 'schedule'])

type History = Effect.Success<ReturnType<typeof readConversationHistory>>

/** A private Thread's plain user turn, or one of the signals above. Vivid's own text never counts. */
const spoken = (message: History['messages'][number]) =>
  message.purpose === 'user' ||
  (message.purpose === 'dispatch' &&
    message.signal !== undefined &&
    message.signal.tagName !== undefined &&
    SPOKEN.has(message.signal.tagName))

/**
 * What the acting Person asked for, in their own words, for the reviewer of a proposed action.
 *
 * The working model's summary and rationale are its account of the request and cannot vouch for
 * themselves. Flue's history has the words and `RunStore` has the attribution Flue does not keep
 * (`threads/runs.ts`): a history message counts only when its submission is a Run this server
 * recorded as acting for the acting Person. Names in the conversation are never compared, so
 * another member of a shared Thread, or text Vivid wrote, cannot stand in for the request.
 *
 * `None` means the request could not be read: no Thread, no such message, or the history read
 * failed or passed five seconds. It never fails; the gate treats `None` as an unreviewed action.
 */
export const personRequest = Effect.fn('Review.personRequest')(
  function* (
    runtime: Pick<RuntimeService, 'read'>,
    runs: Pick<RunStoreService, 'list'>,
    actor: Actor,
  ) {
    if (Option.isNone(actor.threadId)) return Option.none<Arr.NonEmptyReadonlyArray<string>>()
    const threadId = actor.threadId.value
    const recorded = yield* runs.list(threadId)
    const mine = new Set<string>(
      recorded.flatMap((run) => (run.origin.person.id === actor.person.id ? [run.id] : [])),
    )
    const history = yield* readConversationHistory(runtime, threadId)
    const words = history.messages.flatMap((message) => {
      if (message.submissionId === undefined || !mine.has(message.submissionId)) return []
      const text = textOf(message).trim()
      return spoken(message) && text.length > 0 ? [text.slice(0, REQUEST_CHARACTERS)] : []
    })
    const recent = words.slice(-REQUEST_MESSAGES)
    return Arr.isReadonlyArrayNonEmpty(recent) ? Option.some(recent) : Option.none()
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout('5 seconds'),
      Effect.catch((error) =>
        Effect.logWarning('Review request unavailable', { tag: error._tag }).pipe(
          Effect.as(Option.none<Arr.NonEmptyReadonlyArray<string>>()),
        ),
      ),
    ),
)
