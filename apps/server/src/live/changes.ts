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
import * as Predicate from 'effect/Predicate'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { DatabaseFailure, type CompanyId, type PersonId, type ThreadId } from '@vivid/contracts'
import { companyOf, type Actor } from '../auth/access.ts'
import type { Database } from '../database/client.ts'
import { LiveTally, type Moved } from './tally.ts'

/**
 * A kind of an owner's data that a write can say it moved, and nothing else of that owner.
 *
 * - `activity`: a Thread's Runs, its last words, its read marks. Not a Thread appearing, going
 *   away, being renamed or changing who may see it: those are announced whole.
 * - `notifications`: a Person's notifications and whether they were read.
 * - `drafts`: what a Person has typed and not sent.
 *
 * These three are the writes one conversation turn makes. On 12 Oct 2026 production counted one
 * turn reloading each of a Person's twenty open queries three times, and their session twenty
 * times each, for three queries that had anything new to send.
 */
export const Part = Schema.Literals(['activity', 'notifications', 'drafts', 'feed'])
export type Part = typeof Part.Type

type Owner = `p:${string}` | `c:${string}` | `t:${string}`

/**
 * What changed: everything a Person owns, everything a Company holds, or one Thread; or one named
 * part of one of those.
 *
 * A topic is wide unless its writer narrows it. A write that names only an owner says "something
 * of theirs moved": every live query watching that owner runs again, and a result identical to
 * the last one is not sent (`live/query.ts`). That keeps "did I remember to invalidate it" out of
 * every handler: a handler names the owner it wrote for and is done.
 *
 * A writer on a path hot enough to matter may say which `Part` moved (`Topic.part`). Only the
 * queries that read that part run again (`Reads`). The two sides are checked against each other
 * by reading, not by the compiler: a writer that narrows a topic must write nothing a query
 * outside that part shows. When in doubt a writer stays wide, which is always correct.
 *
 * The part sits before the colon (`p/activity:<id>`) because an identifier is not constrained
 * and may hold any character after it.
 */
export type Topic = Owner | `${string}/${Part}:${string}`

export const Topic = {
  person: (id: PersonId): Topic => `p:${id}`,
  company: (id: CompanyId): Topic => `c:${id}`,
  thread: (id: ThreadId): Topic => `t:${id}`,
  /** The same owner, saying that only this part of their data moved. A narrowed topic is kept. */
  part:
    (part: Part) =>
    (topic: Topic): Topic => {
      const colon = topic.indexOf(':')
      return Option.isSome(moving(topic).part)
        ? topic
        : `${topic.slice(0, colon)}/${part}:${topic.slice(colon + 1)}`
    },
}

/**
 * The parts of an owner's data a live query shows. A query always hears a wide topic; of the
 * narrowed ones it hears only these. `everyPart` is for a subscriber that has not been read
 * against the narrowed writers and so must hear all of them.
 */
export type Reads = ReadonlyArray<Part>
export const everyPart: Reads = Part.literals

/**
 * A moved topic as its owner and the part it names, when it names one. The part, if any, is
 * between a slash and the first colon; a slash after that colon belongs to the identifier.
 */
const moving = (topic: string) => {
  const colon = topic.indexOf(':')
  const slash = topic.indexOf('/')
  return slash === -1 || slash > colon
    ? { owner: topic, part: Option.none<string>() }
    : {
        owner: `${topic.slice(0, slash)}${topic.slice(colon)}`,
        part: Option.some(topic.slice(slash + 1, colon)),
      }
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
   * A stream with one element each time any of these owners moves: every wide move, and a
   * narrowed one only when it names a part in `reads` (`everyPart` hears them all). The
   * subscription is live from the moment this effect returns, so a caller that subscribes and
   * then reads cannot miss a write made between the two.
   */
  readonly subscribe: (
    topics: ReadonlyArray<Topic>,
    reads: Reads,
  ) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

/**
 * The change bus behind every live query.
 *
 * PostgreSQL `LISTEN`/`NOTIFY` carries it, on one channel, because the writers are not all in this
 * process: background workers, a second server instance and a migration all
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

/**
 * Whether a notification names an owner a subscriber asked for, wide or in a part it reads.
 * A subscriber names owners; a narrowed topic among them is read as its owner.
 */
export const touches = (topics: ReadonlyArray<string>, reads: Reads) => {
  const wanted = new Set(topics.map((topic) => moving(topic).owner))
  const read = new Set<string>(reads)
  return (moved: ReadonlyArray<string>) =>
    moved.some((topic) => {
      if (topic === EVERYTHING) return true
      const { owner, part } = moving(topic)
      return (
        wanted.has(owner) &&
        Option.match(part, { onNone: () => true, onSome: (named) => read.has(named) })
      )
    })
}

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

/** Paces a Layer-owned connection supervisor after typed connection loss. Permanent SQL
 * failures stop it. Source: unmeasured. The owning scope cancels transient recovery on shutdown. */
const LISTEN_RECONNECT_DELAY = '2 seconds'

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

  // Only a lost connection is transient. Authentication, authorization and statement failures
  // stop the listener visibly; re-running LISTEN cannot repair those conditions.
  const listener = yield* listen.pipe(
    Effect.retry({
      schedule: Schedule.spaced(LISTEN_RECONNECT_DELAY),
      while: (error) => Predicate.isTagged(error.reason, 'ConnectionError'),
    }),
    Effect.tapError((error) =>
      Effect.logError('The change listener stopped', { failure: error.reason._tag }),
    ),
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
    // Split by bytes like `announce`: a Thread shared with enough People names more topics than
    // one payload holds, and a rejected payload would be a refresh nobody received.
    yield* notificationPayloads(topics).pipe(
      Effect.flatMap(Effect.forEach((payload) => sql.notify(CHANNEL, payload), { discard: true })),
      Effect.catch(notificationNotSent),
    )
  })

  const subscribe = Effect.fn('Changes.subscribe')(function* (
    topics: ReadonlyArray<Topic>,
    reads: Reads,
  ) {
    const subscription = yield* PubSub.subscribe(hub)
    return Stream.fromSubscription(subscription).pipe(
      Stream.filter(touches(topics, reads)),
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
