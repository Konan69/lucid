import * as NodeCrypto from 'node:crypto'
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  FeedCardId,
  FeedItem,
  FeedPost,
  FeedResponse,
  NotFound,
  PostOutcome,
  type MarkFeedCardRequest,
  type PersonId,
  type PostRequest,
  type ThreadId,
} from '@vivid/contracts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { runs, threads } from '../threads/tables.ts'
import { feedCards } from './tables.ts'

const decodePost = decodeStored(Schema.NullOr(FeedPost), 'Feed post')

/** How far back settled work stays on the Feed: the last day, so morning still shows the night. */
const SETTLED_WINDOW = 24 * 60 * 60 * 1000

/** Every Feed write moves only the Person's Feed, so open Thread lists do not reload for it. */
const feedTopic = (person: PersonId) => [Topic.part('feed')(Topic.person(person))]

/**
 * A card's id is its Thread's, hashed: one Thread has one card, and a replayed post finds the
 * same row without a lookup. The Thread id itself stays off the card's identity on the wire.
 */
const cardIdOf = (thread: ThreadId) =>
  FeedCardId.make(NodeCrypto.createHash('sha256').update(`feed:${thread}`).digest('hex'))

interface RunTimes {
  readonly working: number | null
  readonly finished: number | null
}
/** A background Thread whose first Run has not been recorded yet: it has neither time. */
const NO_RUNS: RunTimes = { working: null, finished: null }

/**
 * Which stage one background Thread is in. A Run going now wins: the work is not over whatever
 * the card says. Otherwise an open card waits on the Person, and anything else is settled.
 */
const stageOf = (input: {
  readonly thread: ThreadId
  readonly from: string
  readonly moved: number
  readonly card: typeof feedCards.$inferSelect | null
  readonly post: FeedPost | null
  readonly times: RunTimes
}): FeedItem => {
  const base = { card: cardIdOf(input.thread), thread: input.thread, from: input.from }
  if (input.times.working !== null)
    return FeedItem.cases.Working.make({ ...base, since: input.times.working, post: input.post })
  if (input.card !== null && input.post !== null && input.card.state !== 'done')
    return FeedItem.cases.Waiting.make({
      ...base,
      at: input.card.updatedAt,
      post: input.post,
      seen: input.card.state === 'seen',
    })
  // Settled when the Person put the card away, else when the last Run ended, else when it moved.
  const at = input.card !== null ? input.card.updatedAt : (input.times.finished ?? input.moved)
  return FeedItem.cases.Settled.make({ ...base, at, post: input.post })
}

/** When an item last moved, for ordering every stage in one list. */
const atOf = (item: FeedItem) =>
  FeedItem.match(item, {
    Working: ({ since }) => since,
    Waiting: ({ at }) => at,
    Settled: ({ at }) => at,
  })

const makeStore = (database: Database['Service']) => {
  /**
   * The Person's background Threads the Feed shows: every one with a card still open, and every
   * one that moved in the last day. Each comes with its card when Vivid posted one.
   */
  const recent = Effect.fn('FeedStore.recent')(function* (person: PersonId, since: number) {
    return yield* database.run(
      database
        .select({
          thread: threads.id,
          from: threads.title,
          moved: threads.updatedAt,
          card: feedCards,
        })
        .from(threads)
        .leftJoin(feedCards, eq(feedCards.threadId, threads.id))
        .where(
          and(
            eq(threads.personId, person),
            eq(threads.place, 'Background'),
            or(gte(threads.updatedAt, since), inArray(feedCards.state, ['new', 'seen'])),
          ),
        )
        .orderBy(desc(threads.updatedAt))
        .limit(100),
    )
  })

  /** For each of those Threads, when its working Run began (if one is going) and its last end. */
  const runsOf = Effect.fn('FeedStore.runsOf')(function* (ids: ReadonlyArray<ThreadId>) {
    if (ids.length === 0) return new Map<ThreadId, RunTimes>()
    const rows = yield* database.run(
      database
        .select({
          thread: runs.threadId,
          working: sql<
            number | null
          >`min(${runs.startedAt}) filter (where ${runs.state} = 'working')`.mapWith((value) =>
            value === null ? null : Number(value),
          ),
          finished: sql<number | null>`max(${runs.finishedAt})`.mapWith((value) =>
            value === null ? null : Number(value),
          ),
        })
        .from(runs)
        .where(inArray(runs.threadId, [...ids]))
        .groupBy(runs.threadId),
    )
    return new Map(rows.map((row) => [row.thread, row] as const))
  })

  /** The whole Feed, shared by List and Watch: every item in its stage, newest first. */
  const list = Effect.fn('FeedStore.list')(function* (person: PersonId) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* recent(person, now - SETTLED_WINDOW)
    const times = yield* runsOf(rows.map((row) => row.thread))
    const items = yield* Effect.forEach(rows, (row) =>
      Effect.map(
        decodePost(
          row.card === null
            ? null
            : {
                title: row.card.title,
                words: row.card.words,
                display: row.card.display,
                actions: row.card.actions,
              },
        ),
        (post) => stageOf({ ...row, post, times: times.get(row.thread) ?? NO_RUNS }),
      ),
    )
    return FeedResponse.make({
      items: items.toSorted((a, b) => atOf(b) - atOf(a)),
    })
  })

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
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(feedCards)
          .set({ state: request.state })
          .where(and(eq(feedCards.id, request.card), eq(feedCards.personId, person)))
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
