import * as NodeBuffer from 'node:buffer'
import { PgClient } from '@effect/sql-pg/PgClient'
import { sql as drizzleSql } from 'drizzle-orm'
import * as Array from 'effect/Array'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Latch from 'effect/Latch'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { DatabaseFailure, type CompanyId, type PersonId, type ThreadId } from '@vivid/contracts'
import { companyOf, type Actor } from '../auth/access.ts'
import type { Database } from '../database/client.ts'
import { LiveTally, type Moved } from './tally.ts'

/**
 * What changed, coarsely: everything a Person owns, everything a Company holds, or one Thread.
 *
 * Topics are deliberately wide. A write does not say which query it affects; it says whose data
 * moved, every live query watching that owner runs again, and a result identical to the last one
 * is not sent (`live/query.ts`). That keeps "did I remember to invalidate it" out of every
 * handler: a handler names the owner it wrote for and is done.
 */
export type Topic = `p:${string}` | `c:${string}` | `t:${string}`

export const Topic = {
  person: (id: PersonId): Topic => `p:${id}`,
  company: (id: CompanyId): Topic => `c:${id}`,
  thread: (id: ThreadId): Topic => `t:${id}`,
}

/** The topics an Actor's own writes touch: themselves, and their Company when they are in one. */
export const topicsOf = (actor: Pick<Actor, 'person' | 'workspace'>): ReadonlyArray<Topic> => [
  Topic.person(actor.person.id),
  ...Option.match(companyOf(actor.workspace), {
    onNone: () => [],
    onSome: (company) => [Topic.company(company.id)],
  }),
]

export interface ChangesService {
  /** Says these owners' data moved. Never fails the write that already happened. */
  readonly publish: (topics: ReadonlyArray<Topic>) => Effect.Effect<void>
  /**
   * A stream with one element each time any of these topics moves. The subscription is live from
   * the moment this effect returns, so a caller that subscribes and then reads cannot miss a write
   * made between the two.
   */
  readonly subscribe: (
    topics: ReadonlyArray<Topic>,
  ) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

/**
 * The change bus behind every live query.
 *
 * PostgreSQL `LISTEN`/`NOTIFY` carries it, on one channel, because the writers are not all in this
 * process: the Routine scheduler, a second server instance and a migration all
 * change data that an open client must hear about. Each process holds one listening connection
 * and fans notifications out to its own subscribers through an in-memory hub.
 *
 * A notification names topics and carries no data, so nothing private crosses the channel.
 */
export class Changes extends Context.Service<Changes, ChangesService>()('vivid/Changes') {}

export const CHANNEL = 'vivid_changes'
const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/** The authoritative callback type keeps this capability restricted to a real Drizzle transaction. */
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/** PostgreSQL 18 NOTIFY requires each UTF-8 payload to be strictly shorter than 8000 bytes. */
const NOTIFICATION_BYTES = 8_000

/**
 * Partition the encoded audience by bytes, not count: branded identifiers do not constrain length
 * or Unicode. Validate each owner's complete representation before issuing any statement. The
 * two brackets and inter-topic commas belong to this wire budget; no owner may be truncated.
 * Each first owner fits, so every chop step consumes a prefix and makes progress.
 * rc.116 Array.chop and splitWhere consume bounded prefixes without rebuilding a grouping loop.
 * Source: https://www.postgresql.org/docs/18/sql-notify.html (payload and transaction ordering).
 */
export const notificationPayloads = Effect.fn('Changes.payloads')(function* (
  topics: ReadonlyArray<Topic>,
) {
  const encoded = yield* Effect.forEach(topics, (topic) => {
    const bytes = NodeBuffer.Buffer.byteLength(JSON.stringify(topic), 'utf8')
    return bytes + 2 >= NOTIFICATION_BYTES
      ? Effect.fail(
          new DatabaseFailure({ message: 'Change notification exceeds its payload limit' }),
        )
      : Effect.succeed({ topic, bytes })
  })
  return Array.chop(encoded, (remaining) => {
    // Starting at one accounts for both brackets after adding the first entry's delimiter byte.
    let bytes = 1
    const [batch, rest] = Array.splitWhere(remaining, (entry) => {
      bytes += entry.bytes + 1
      return bytes >= NOTIFICATION_BYTES
    })
    return [JSON.stringify(batch.map((entry) => entry.topic)), rest]
  })
})

/**
 * Announce on the writing connection so PostgreSQL emits only at commit and rollback emits nothing.
 * drizzle-orm/effect-postgres/session.js:24-29 reuses its SqlClient transaction; rc.116
 * unstable/sql/SqlClient.ts:162-171 selects that connection from fiber context. PgClient.notify
 * instead checks out another connection (PgClient.ts:256-263), so it cannot join this write.
 * Driver failures stay typed and Database.transaction classifies them while rolling back the write.
 */
export const announce = Effect.fn('Changes.announce')(function* (
  transaction: Transaction,
  topics: ReadonlyArray<Topic>,
) {
  const payloads = yield* notificationPayloads(topics)
  yield* Effect.forEach(payloads, (payload) =>
    transaction.execute(drizzleSql`select pg_notify(${CHANNEL}, ${payload})`),
  )
})

/** Whether a notification names any topic a subscriber asked for. */
const touches = (wanted: ReadonlySet<string>) => (moved: ReadonlyArray<string>) =>
  moved.some((topic) => topic === EVERYTHING || wanted.has(topic))

/** The topic that touches every subscriber. Only the listener publishes it, when it reconnects. */
const EVERYTHING = '*'

/** The kind of owner a topic names, for the bus's counts (`live/tally.ts`). */
const kinds: ReadonlyMap<string, Moved> = new Map([
  ['p', 'person'],
  ['c', 'company'],
  ['t', 'thread'],
  [EVERYTHING, 'everything'],
])
const kindOf = (topic: string) => Option.fromUndefinedOr(kinds.get(topic.slice(0, 1)))

const notificationNotSent = () => Effect.logWarning('A change notification could not be sent')

/** Scoped listener acquisition confirms its first LISTEN before exposing a subscribable bus. */
const makeChanges = Effect.fn('Changes.make')(function* () {
  const sql = yield* PgClient
  const hub = yield* PubSub.unbounded<ReadonlyArray<string>>()
  const ready = yield* Latch.make()
  const tally = yield* LiveTally

  /** Every notification this process hears is counted by the owners it names, then fanned out. */
  const heard = (topics: ReadonlyArray<string>) =>
    Effect.sync(() => {
      for (const kind of new Set(Array.getSomes(topics.map(kindOf)))) tally.moved(kind)
    }).pipe(Effect.andThen(PubSub.publish(hub, topics)))

  /** Invalid external payloads are ignored; valid topics still fan out through the real hub. */
  const forward = (payload: string) =>
    decodeTopics(payload).pipe(
      Effect.flatMap(heard),
      Effect.catchTag('SchemaError', () =>
        Effect.logWarning('Ignored a malformed change notification'),
      ),
    )

  /**
   * One listening connection, held for as long as it lasts. Each time it is (re)established every
   * subscriber is told to reload (`EVERYTHING`): whatever was written while nothing was listening
   * was never announced, and a reload is the only way to be sure a screen is not showing the past.
   */
  const listen = Effect.gen(function* () {
    const notifications = yield* sql.listen(CHANNEL)
    yield* heard([EVERYTHING])
    // PgConnection.ts:1833-1834 awaits LISTEN confirmation. Open after the reload broadcast so
    // a new subscriber cannot mistake startup's EVERYTHING for its first committed announcement.
    yield* ready.open
    yield* Stream.runForEach(Stream.fromQueue(notifications), (notification) =>
      forward(notification.payload),
    )
  }).pipe(Effect.scoped)

  // The listener is supervised for the life of the server: a dropped connection is logged and
  // re-opened, never left dead with every live query quietly going stale.
  const listener = yield* listen.pipe(
    Effect.catchTag('SqlError', () =>
      Effect.logWarning('The change listener lost its connection; reconnecting'),
    ),
    Effect.repeat(Schedule.spaced('2 seconds')),
    Effect.forkScoped,
  )
  // Propagate startup defects instead of awaiting a latch that a dead listener cannot open.
  // rc.116 internal/effect.ts:860-866 removes only join's observer when the readiness race wins;
  // the listener itself remains owned by this Layer's scope.
  yield* Effect.raceFirst(ready.await, Fiber.join(listener))

  const publish = Effect.fn('Changes.publish')(function* (topics: ReadonlyArray<Topic>) {
    if (topics.length === 0) return
    // The write is already committed. If the notification cannot be sent, open clients miss one
    // refresh; failing the caller would instead report a successful write as a failure.
    yield* sql.notify(CHANNEL, JSON.stringify(topics)).pipe(Effect.catch(notificationNotSent))
  })

  const subscribe = Effect.fn('Changes.subscribe')(function* (topics: ReadonlyArray<Topic>) {
    const wanted = new Set<string>(topics)
    const subscription = yield* PubSub.subscribe(hub)
    return Stream.fromSubscription(subscription).pipe(
      Stream.filter(touches(wanted)),
      Stream.map(() => undefined),
    )
  })

  return Changes.of({ publish, subscribe })
})

export const changesLayer = Layer.effect(Changes, makeChanges())

/** A bus that carries nothing, for tests of logic that publishes but is not about publishing. */
export const silentChangesLayer = Layer.succeed(
  Changes,
  Changes.of({
    publish: () => Effect.void,
    subscribe: () => Effect.succeed(Stream.never),
  }),
)

/** Says the Actor's own data moved. The common case for a handler that just wrote. */
export const changed = Effect.fn('Changes.changed')(function* (
  actor: Pick<Actor, 'person' | 'workspace'>,
  ...more: ReadonlyArray<Topic>
) {
  const changes = yield* Changes
  yield* changes.publish([...topicsOf(actor), ...more])
})
