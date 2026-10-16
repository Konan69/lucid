import * as NodeCrypto from 'node:crypto'
import { and, desc, eq, exists, gt, gte, inArray, not, or, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  FeedCardId,
  FeedItem,
  FeedPost,
  FeedResponse,
  type FeedAsk,
  type PersonId,
  ThreadId,
} from '@vivid/contracts'
import { approvals } from '../approvals/tables.ts'
import { decodeStored, type Database } from '../database/client.ts'
import { inputRequests } from '../inputs/tables.ts'
import { readableBy } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { feedCards } from './tables.ts'

/**
 * Reading the Feed: every background Thread of the Person that is still open or settled in the
 * last day, each put in its stage. The Feed knows nothing of what started the work; it reads the
 * Thread, its card, its Runs and anything it is waiting on, the same for every source.
 */

const decodePost = decodeStored(Schema.NullOr(FeedPost), 'Feed post')

/** How far back settled work stays on the Feed: the last day, so morning still shows the night. */
const SETTLED_WINDOW = 24 * 60 * 60 * 1000
/** Settled lines are history: the newest are enough. Open work is never capped. */
const HISTORY_LIMIT = 100

/**
 * A card's id is its Thread's, hashed: one Thread has one card, and a replayed post finds the
 * same row without a lookup. The Thread id itself stays off the card's identity on the wire.
 */
export const cardIdOf = (thread: ThreadId) =>
  FeedCardId.make(NodeCrypto.createHash('sha256').update(`feed:${thread}`).digest('hex'))

type Db = Database['Service']

interface Row {
  readonly thread: ThreadId
  readonly from: string
  readonly moved: number
  readonly card: typeof feedCards.$inferSelect | null
}

interface RunTimes {
  readonly working: number | null
  readonly finished: number | null
}
/** A background Thread whose first Run has not been recorded yet: it has neither time. */
const NO_RUNS: RunTimes = { working: null, finished: null }

/** What one Thread is waiting on the Person for, and since when. */
interface Asks {
  readonly asking: ReadonlyArray<FeedAsk>
  readonly since: number
}
const NO_ASKS: Asks = { asking: [], since: 0 }

const fields = {
  thread: threads.id,
  from: threads.title,
  moved: threads.updatedAt,
  card: feedCards,
}

/**
 * The Person's own background Threads, and only while they can still read them: a Company one
 * stops when they leave. Readability alone would admit another Person's readable Thread.
 */
const mine = (person: PersonId) =>
  and(eq(threads.personId, person), readableBy(person), eq(threads.place, 'Background'))

/**
 * When a Thread last settled, as the Feed dates it: the later of its last activity and the moment
 * its card was put away, so an old Thread whose card was settled today stays in today's history.
 */
const settledAt = sql<number>`greatest(${threads.updatedAt}, coalesce(${feedCards.updatedAt}, 0))`

/**
 * Whether a Thread still needs its stage worked out whatever its age: a card not put away, a Run
 * going, an Approval undecided or a question unanswered. None of these may fall off the Feed.
 */
const stillOpen = (now: number) =>
  or(
    inArray(feedCards.state, ['new', 'seen']),
    exists(
      sql`(select 1 from ${runs} where ${runs.threadId} = ${threads.id} and ${runs.state} = 'working')`,
    ),
    exists(
      sql`(select 1 from ${approvals} where ${approvals.threadId} = ${threads.id} and ${approvals.status} = 'pending' and ${approvals.expiresAt} > ${now})`,
    ),
    exists(
      sql`(select 1 from ${inputRequests} where ${inputRequests.threadId} = ${threads.id} and ${inputRequests.status} = 'waiting')`,
    ),
  )

/**
 * Two reads: everything still open, all of it whatever its age, so nothing waiting on the Person
 * can fall off the Feed; and the settled history of the last day, capped, dated by `settledAt`.
 */
const readThreads = Effect.fn('Feed.readThreads')(function* (
  db: Db,
  person: PersonId,
  now: number,
) {
  const open = yield* db.run(
    db
      .select(fields)
      .from(threads)
      .leftJoin(feedCards, eq(feedCards.threadId, threads.id))
      .where(and(mine(person), stillOpen(now)))
      .orderBy(desc(threads.updatedAt)),
  )
  const history = yield* db.run(
    db
      .select(fields)
      .from(threads)
      .leftJoin(feedCards, eq(feedCards.threadId, threads.id))
      .where(and(mine(person), not(stillOpen(now)), gte(settledAt, now - SETTLED_WINDOW)))
      .orderBy(desc(settledAt))
      .limit(HISTORY_LIMIT),
  )
  const rows: ReadonlyArray<Row> = [...open, ...history]
  return rows
})

/** A nullable aggregate as a number or null; Postgres sends bigints as text. */
const epochOrNull = (value: string | number | null) => (value === null ? null : Number(value))

/** For each Thread, when its working Run began (if one is going) and when its last one ended. */
const readRuns = Effect.fn('Feed.readRuns')(function* (db: Db, ids: ReadonlyArray<ThreadId>) {
  if (ids.length === 0) return new Map<ThreadId, RunTimes>()
  const rows = yield* db.run(
    db
      .select({
        thread: runs.threadId,
        working: sql<
          number | null
        >`min(${runs.startedAt}) filter (where ${runs.state} = 'working')`.mapWith(epochOrNull),
        finished: sql<number | null>`max(${runs.finishedAt})`.mapWith(epochOrNull),
      })
      .from(runs)
      .where(inArray(runs.threadId, [...ids]))
      .groupBy(runs.threadId),
  )
  return new Map(rows.map((row) => [row.thread, row] as const))
})

/** For each Thread, the Approvals and questions still waiting on the Person, and the earliest. */
const readAsks = Effect.fn('Feed.readAsks')(function* (
  db: Db,
  ids: ReadonlyArray<ThreadId>,
  now: number,
) {
  const asks = new Map<ThreadId, Asks>()
  if (ids.length === 0) return asks
  const pending = yield* db.run(
    db
      .select({ thread: approvals.threadId, at: approvals.createdAt })
      .from(approvals)
      .where(
        and(
          inArray(approvals.threadId, [...ids]),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, now),
        ),
      ),
  )
  const waiting = yield* db.run(
    db
      .select({ thread: inputRequests.threadId, at: inputRequests.createdAt })
      .from(inputRequests)
      .where(and(inArray(inputRequests.threadId, [...ids]), eq(inputRequests.status, 'waiting'))),
  )
  const add = (kind: FeedAsk) => (row: { readonly thread: string; readonly at: number }) => {
    const thread = ThreadId.make(row.thread)
    const before = asks.get(thread) ?? NO_ASKS
    asks.set(thread, {
      asking: before.asking.includes(kind) ? before.asking : [...before.asking, kind],
      since: Math.max(before.since, row.at),
    })
  }
  pending.forEach(add('approval'))
  waiting.forEach(add('question'))
  return asks
})

/**
 * Which stage one background Thread is in. Waiting on the Person wins over a Run going, because
 * a Run stopped on an Approval or a question is still open while it waits; then a Run going;
 * then a card not put away; anything else is settled.
 */
const stageOf = (row: Row, post: FeedPost | null, times: RunTimes, asks: Asks): FeedItem => {
  const base = { card: cardIdOf(row.thread), thread: row.thread, from: row.from }
  const cardOpen = row.card !== null && row.card.state !== 'done'
  if (asks.asking.length > 0 || (cardOpen && post !== null && times.working === null))
    return FeedItem.cases.Waiting.make({
      ...base,
      at: Math.max(asks.since, row.card === null ? 0 : row.card.updatedAt),
      post,
      seen: row.card !== null && row.card.state === 'seen',
      asking: asks.asking,
    })
  if (times.working !== null)
    return FeedItem.cases.Working.make({ ...base, since: times.working, post })
  // Settled when the Person put the card away, else when the last Run ended, else when it moved.
  const at = row.card !== null ? row.card.updatedAt : (times.finished ?? row.moved)
  return FeedItem.cases.Settled.make({ ...base, at, post })
}

/** When an item last moved, for ordering every stage in one list. */
const atOf = (item: FeedItem) =>
  FeedItem.match(item, {
    Working: ({ since }) => since,
    Waiting: ({ at }) => at,
    Settled: ({ at }) => at,
  })

/** The card's words as the contract carries them, or none when Vivid has not posted. */
const postOf = (card: Row['card']) =>
  decodePost(
    card === null
      ? null
      : { title: card.title, words: card.words, display: card.display, actions: card.actions },
  )

/** The whole Feed, shared by List and Watch: every item in its stage, newest first. */
export const readFeed = Effect.fn('Feed.read')(function* (db: Db, person: PersonId) {
  const now = yield* Clock.currentTimeMillis
  const rows = yield* readThreads(db, person, now)
  const ids = rows.map((row) => row.thread)
  const times = yield* readRuns(db, ids)
  const asks = yield* readAsks(db, ids, now)
  const items = yield* Effect.forEach(rows, (row) =>
    Effect.map(postOf(row.card), (post) =>
      stageOf(row, post, times.get(row.thread) ?? NO_RUNS, asks.get(row.thread) ?? NO_ASKS),
    ),
  )
  return FeedResponse.make({ items: items.toSorted((a, b) => atOf(b) - atOf(a)) })
})
