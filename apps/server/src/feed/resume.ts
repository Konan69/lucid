import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import {
  FeedOpening,
  MarkFeedCardRequest,
  NotFound,
  SignalCue,
  type ConversationState,
  type PersonId,
  type ResumeFeedItemRequest,
  type ThreadId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { Runtime } from '../runtime/client.ts'
import { readThreadHistory, textOf } from '../runtime/history.ts'
import { requireThread } from '../threads/access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { messageKey } from '../threads/key.ts'
import { ThreadStore } from '../threads/store.ts'
import { cardIdOf } from './read.ts'
import { FeedStore } from './store.ts'
import { feedCards } from './tables.ts'

/** The newest messages of the work handed over; a Background Thread rarely holds more. */
const HANDED_MOST = 20
/** The most characters of one message handed over, as `read_thread` returns at most. */
const MESSAGE_LONGEST = 1500

/** A posted card's columns: a said card has words, a drawn one its display (`store.ts` `columnsOf`). */
interface Card {
  readonly title: string
  readonly words: string | null
  readonly display: string | null
  readonly from: string | null
}

const clip = (text: string) =>
  text.length > MESSAGE_LONGEST ? `${text.slice(0, MESSAGE_LONGEST)} [cut]` : text

/**
 * Who said a message of the work, as Vivid reads its own conversations: the Person, Vivid, or the
 * kind of delivery that woke it (an Integration event, a check-in). Advisories about a failed
 * reply and messages no screen draws are not the work.
 */
const speakerOf = (message: ConversationState['messages'][number]) => {
  if (message.display === 'hidden' || message.purpose === 'advisory') return undefined
  if (message.purpose === 'user') return 'Person'
  if (message.purpose === 'assistant') return 'Vivid'
  return message.signal === undefined ? undefined : message.signal.tagName
}

/** The work's own words, oldest first, the newest `HANDED_MOST` of them. */
const transcriptOf = (history: ConversationState) => {
  const lines = history.messages.flatMap((message) => {
    const speaker = speakerOf(message)
    const text = textOf(message).trim()
    return speaker === undefined || text.length === 0 ? [] : [`${speaker}: ${clip(text)}`]
  })
  const kept = lines.slice(-HANDED_MOST)
  return kept.length < lines.length ? ['(earlier messages left out)', ...kept] : kept
}

/** What the Feed shows of the work, when Vivid posted a card for it. */
const cardLines = (card: Card) => [
  `The Feed card: ${card.title}`,
  ...(card.from === null ? [] : [`It came from: ${card.from}`]),
  ...(card.words === null ? [] : [`It says: ${card.words}`]),
  ...(card.display === null ? [] : [`It draws: ${clip(card.display)}`]),
]

/**
 * The work as Vivid is handed it in the new Conversation: named by its title, never its id, the
 * card the Person pressed, and the work's own words. The Person has said nothing yet, so the
 * order of who speaks is spelt out, as the first Thread's instruction does (`threads/message.ts`).
 */
const handedOver = (
  title: string,
  opening: FeedOpening,
  card: ReadonlyArray<Card>,
  history: ConversationState,
) =>
  [
    FeedOpening.match(opening, {
      Looking: () =>
        `The Person pressed earlier work on their Feed, "${title}", to talk about it here. This is a new conversation; the work goes on where it was. Nothing has been said here yet, so you speak first: say in a sentence or two where that work stands and what, if anything, it needs from them, then let them lead. Do nothing about the work until they ask.`,
      Answered: ({ words }) =>
        `The Person answered the card for earlier work on their Feed, "${title}", by pressing "${words}", and came here to see it done. This is a new conversation about that work. Act on their answer now, as you would have if they had said it in the work's own conversation, then say here in a sentence or two what you did, or what stopped you.`,
    }),
    ...card.flatMap(cardLines),
    ['The work so far, oldest first:', ...transcriptOf(history)].join('\n'),
  ].join('\n\n')

/** The card Vivid posted for the work, if it posted one, as its row holds it. */
const cardOf = Effect.fn('Feed.resume.card')(function* (person: PersonId, thread: ThreadId) {
  const database = yield* Database
  return yield* database.run(
    database
      .select({
        title: feedCards.title,
        words: feedCards.words,
        display: feedCards.display,
        from: feedCards.cameFrom,
      })
      .from(feedCards)
      .where(and(eq(feedCards.threadId, thread), eq(feedCards.personId, person)))
      .limit(1),
  )
})

/**
 * Starts a new Conversation about one Feed item's work and hands Vivid that work there. Only the
 * Person's own Threads are on their Feed (`read.ts` `mine`), so only those can be carried over.
 * The work is read before anything is made, so a history that cannot be read leaves no empty
 * Conversation behind. The Conversation is created under the client's id and the hand-over is
 * admitted under the client's key, so a press sent again finds both instead of making a second.
 * The hand-over is a `carry-on` signal, which no screen draws: what the Person sees is Vivid's
 * answer, never words put in their mouth.
 */
export const resumeFeedItem = Effect.fn('Feed.resume')(function* (
  actor: Actor,
  request: ResumeFeedItemRequest,
) {
  const person = actor.person.id
  const work = yield* requireThread(request.work, person)
  if (work.personId !== person) return yield* new NotFound({ message: 'Thread not found' })
  const history = yield* readThreadHistory(yield* Runtime, work.id).pipe(Effect.scoped)
  const card = yield* cardOf(person, work.id)
  const thread = yield* (yield* ThreadStore).create(actor, {
    id: request.conversation,
    title: work.title,
    projectId: null,
  })
  yield* (yield* Conversation).admit({
    threadId: thread.id,
    personId: person,
    speaker: DeliverySpeaker.cases.Acting.make({}),
    message: DeliveryMessage.cases.Signal.make({
      cue: SignalCue.cases.CarryOn.make({
        body: handedOver(work.title, request.opening, card, history),
      }),
    }),
    // No fingerprint: the hand-over is the server's text, read afresh on a retry, and the key
    // alone names the delivery, as for other server-made text (`StoredRunOrigin.Message`).
    origin: StoredRunOrigin.cases.Message.make({}),
    idempotencyKey: messageKey(person, request.key),
    clientKey: request.key,
  })
  // Answered, the card has had its answer: it is put away as a press on Done puts it away.
  if (FeedOpening.guards.Answered(request.opening) && card.length > 0)
    yield* (yield* FeedStore).mark(
      person,
      MarkFeedCardRequest.make({ card: cardIdOf(work.id), state: 'done' }),
    )
  return { thread }
})
