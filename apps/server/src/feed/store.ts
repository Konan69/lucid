import { and, eq, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  NotFound,
  PostOutcome,
  type MarkFeedCardRequest,
  type PersonId,
  type PostRequest,
  type ThreadId,
} from '@vivid/contracts'
import { Database, returned } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { readableThread } from '../threads/access.ts'
import { cardIdOf, readFeed } from './read.ts'
import { feedCards } from './tables.ts'

/** Every Feed write moves only the Person's Feed, so open Thread lists do not reload for it. */
const feedTopic = (person: PersonId) => [Topic.part('feed')(Topic.person(person))]

const makeStore = (database: Database['Service']) => {
  /** The whole Feed (`read.ts`), shared by List and Watch. */
  const list = (person: PersonId) => readFeed(database, person)

  /**
   * Vivid putting something in front of the Person from a background Thread. The first post makes
   * the card; a later one from the same Thread replaces its words and makes it new again, because
   * a follow-up is news even on a card the Person already looked at or put away.
   */
  const post = Effect.fn('FeedStore.post')(function* (input: {
    readonly person: PersonId
    readonly thread: ThreadId
    readonly request: typeof PostRequest.Type
  }) {
    const now = yield* Clock.currentTimeMillis
    const id = cardIdOf(input.thread)
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .insert(feedCards)
          .values({
            id,
            personId: input.person,
            threadId: input.thread,
            title: input.request.title,
            words: input.request.words,
            display: input.request.display,
            actions: input.request.actions,
            state: 'new',
            postedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: feedCards.threadId,
            set: {
              title: input.request.title,
              words: input.request.words,
              display: input.request.display,
              actions: input.request.actions,
              state: 'new',
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

  /** The Person looked at a card, or dealt with it. Only their own card moves. */
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

  return { list, post, mark }
}

export class FeedStore extends Context.Service<FeedStore, ReturnType<typeof makeStore>>()(
  'vivid/FeedStore',
) {}

export const feedStoreLayer = Layer.effect(
  FeedStore,
  Effect.gen(function* () {
    return FeedStore.of(makeStore(yield* Database))
  }),
)
