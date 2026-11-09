import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  FeedCause,
  FeedDisplayInvalid,
  FeedEvidence,
  FeedProvenance,
  NotFound,
  PostOutcome,
  PostRequest,
  type MarkFeedCardRequest,
  type PersonId,
  type RunId,
  type ThreadId,
  type FeedCardId,
} from '@vivid/contracts'
import { stretches } from '@vivid/contracts/display'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { readableThread } from '../threads/access.ts'
import { StoredRunOrigin, StoredRunOriginColumn } from '../threads/conversation.ts'
import { runs } from '../threads/tables.ts'
import { cardIdOf, readFeed } from './read.ts'
import { feedCards } from './tables.ts'

/**
 * Whether a display draws: OpenUI finds exactly one whole program in it, found the way drawing
 * finds one (`stretches`, as `code/source.ts` reads a reply). A bare `Card([...])` with no
 * `root =` is words to it, so the card would show an empty band.
 */
const draws = (display: string) => {
  const [only, ...rest] = stretches(display)
  return rest.length === 0 && only !== undefined && only.kind === 'display' && only.whole
}

/** Every Feed write moves only the Person's Feed, so open Thread lists do not reload for it. */
const feedTopic = (person: PersonId) => [Topic.part('feed')(Topic.person(person))]

const makeStore = (database: Database['Service']) => {
  /** The whole Feed (`read.ts`), shared by List and Watch. */
  const list = (person: PersonId) => readFeed(database, person)

  /** A posted display belongs to its Feed reader and must still have a readable backing Thread. */
  const display = Effect.fn('FeedStore.display')(function* (person: PersonId, post: FeedCardId) {
    return yield* database.run(
      database
        .select({ thread: feedCards.threadId, text: feedCards.display })
        .from(feedCards)
        .where(
          and(
            eq(feedCards.id, post),
            eq(feedCards.personId, person),
            readableThread(feedCards.threadId, person),
          ),
        )
        .limit(1),
    )
  })

  /**
   * Vivid putting something in front of the Person from a background Thread. The first post makes
   * the card; a later one from the same Thread replaces its words and makes it new again, because
   * a follow-up is news even on a card the Person already looked at or put away.
   */
  const post = Effect.fn('FeedStore.post')(function* (input: {
    readonly person: PersonId
    readonly thread: ThreadId
    /** The Run acting in the Thread now, which posts this content (`actingRun`). */
    readonly postedBy: RunId
    readonly request: PostRequest
  }) {
    // Every caller posts through here, so a display that draws nothing never reaches a card.
    if (PostRequest.guards.Drawn(input.request) && !draws(input.request.display))
      return yield* new FeedDisplayInvalid({ reason: 'NoRoot' })
    const now = yield* Clock.currentTimeMillis
    const id = cardIdOf(input.thread)
    const cited = input.request.sources.map((source) => FeedEvidence.cases.Web.make(source))
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const cause = yield* causeOf(tx, input.thread)
        const columns = {
          ...columnsOf(input.request),
          provenance: yield* encodeProvenance(
            FeedProvenance.cases.Recorded.make({
              postedBy: input.postedBy,
              cause,
              // The cause's Run first: it holds what Vivid saw. Then the pages it read.
              evidence: [
                FeedEvidence.cases.ThreadRun.make({ thread: input.thread, run: cause.run }),
                ...cited,
              ],
            }),
          ),
        }
        const rows = yield* tx
          .insert(feedCards)
          .values({
            id,
            personId: input.person,
            threadId: input.thread,
            ...columns,
            state: 'new',
            toldAt: null,
            postedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: feedCards.threadId,
            set: {
              ...columns,
              state: 'new',
              // New content is news the Person has not been told of (`pace.ts`).
              toldAt: null,
              updatedAt: now,
            },
          })
          // A row this statement inserted has no deleting transaction (xmax 0); one it updated
          // through the conflict clause carries this transaction's id there.
          .returning({ inserted: sql<boolean>`(xmax = 0)` })
        const row = yield* returned(rows, 'Feed card')
        yield* announce(tx, feedTopic(input.person))
        return row.inserted ? PostOutcome.cases.Posted.make({}) : PostOutcome.cases.Updated.make({})
      }),
    )
  })

  /**
   * Only a persisted card can be seen or put away. A derived Feed id without a card row, as in a
   * Conversation, returns NotFound for either mark rather than inventing acknowledgement of an ask.
   */
  const mark = Effect.fn('FeedStore.mark')(function* (
    person: PersonId,
    request: typeof MarkFeedCardRequest.Type,
  ) {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        // The time moves too: a card put away now is settled now, not when it was posted.
        const rows = yield* tx
          .update(feedCards)
          .set({ state: request.state, updatedAt: now })
          .where(
            and(
              eq(feedCards.id, request.card),
              eq(feedCards.personId, person),
              readableThread(feedCards.threadId, person),
            ),
          )
          .returning({ id: feedCards.id })
        if (rows.length === 0) return yield* new NotFound({ message: 'That card is gone.' })
        yield* announce(tx, feedTopic(person))
      }),
    )
  })

  return { list, display, post, mark }
}

export class FeedStore extends Context.Service<FeedStore, ReturnType<typeof makeStore>>()(
  'vivid/FeedStore',
) {}

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
const encodeProvenance = encodeStored(FeedProvenance, 'Feed provenance')
const decodeProvenance = decodeStored(FeedProvenance, 'Feed provenance')
const decodeOrigin = decodeStored(StoredRunOriginColumn, 'Run origin')

/**
 * What started a Thread's work: its first Run, which a later follow-up never replaces. A Run a
 * Watch event started names that Watch and event, one a check-in started names the check-in; any other first Run, or a Watch Run from before
 * events were recorded, is its Run alone. Read from the record, never from the newest Run.
 */
const causeOf = Effect.fn('FeedStore.causeOf')(function* (tx: Transaction, thread: ThreadId) {
  const rows = yield* tx
    .select({ id: runs.id, origin: runs.origin })
    .from(runs)
    .where(eq(runs.threadId, thread))
    .orderBy(asc(runs.turn))
    .limit(1)
  const first = yield* returned(rows, 'The Thread’s first Run')
  const origin = yield* decodeOrigin(first.origin)
  const run = first.id
  const threadRun = (): FeedCause => FeedCause.cases.ThreadRun.make({ run })
  return StoredRunOrigin.match(origin, {
    Watch: ({ watchId, watchName, eventId }): FeedCause =>
      FeedCause.cases.Watch.make({ run, watch: watchId, watchName, eventId }),
    Checkin: ({ watchId, watchName }): FeedCause =>
      FeedCause.cases.Checkin.make({ run, watch: watchId, watchName }),
    Message: threadRun,
    FirstConversation: threadRun,
    Decision: threadRun,
    WatchUnrecorded: threadRun,
    Forget: threadRun,
    Dream: ({ pass }): FeedCause => FeedCause.cases.Dream.make({ run, pass }),
    ChildResult: threadRun,
  })
})

/**
 * Marks the current content of a Thread's card as told. Only an untold card moves, so of two
 * passes that race for one card, one claims it and the other does nothing (`pace.ts`).
 */
export const markTold = Effect.fn('Feed.markTold')(function* (person: PersonId, thread: ThreadId) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.run(
    database
      .update(feedCards)
      .set({ toldAt: now })
      .where(
        and(
          eq(feedCards.threadId, thread),
          eq(feedCards.personId, person),
          isNull(feedCards.toldAt),
        ),
      )
      .returning({ id: feedCards.id }),
  )
  return rows.length > 0
})

/** The Run that posted a Thread's card's current content, when one was recorded. */
export const cardPostedBy = Effect.fn('Feed.cardPostedBy')(function* (
  person: PersonId,
  thread: ThreadId,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ provenance: feedCards.provenance })
      .from(feedCards)
      .where(and(eq(feedCards.threadId, thread), eq(feedCards.personId, person)))
      .limit(1),
  )
  const [row] = rows
  if (row === undefined) return Option.none<RunId>()
  return FeedProvenance.match(yield* decodeProvenance(row.provenance), {
    Recorded: ({ postedBy }) => Option.some(postedBy),
    Legacy: () => Option.none<RunId>(),
  })
})

export const feedStoreLayer = Layer.effect(
  FeedStore,
  Effect.gen(function* () {
    return FeedStore.of(makeStore(yield* Database))
  }),
)

/**
 * A card's columns: a drawn card keeps no words or buttons, a said one no drawing. The read side
 * (`postOf` in `read.ts`) tells them apart by the drawing, so each column holds only its own case.
 */
const columnsOf = (post: PostRequest) => {
  const shown = { cameFrom: post.from, urgency: post.urgency }
  if (PostRequest.guards.Drawn(post))
    return { title: post.title, words: null, display: post.display, actions: [], ...shown }
  return { title: post.title, words: post.words, display: null, actions: post.actions, ...shown }
}
