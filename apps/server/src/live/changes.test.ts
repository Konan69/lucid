import { PgClient, layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { makeWithDefaults as makeDrizzle } from 'drizzle-orm/effect-postgres'
import { Clock, Config, Effect, Layer, Logger, Option, Queue, Schema, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/sql/SqlClient'
import { DatabaseFailure, PersonId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { postgresCodecs } from '../database/codecs.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic, everyPart } from './changes.ts'

/** A deliberate domain failure rolls back an otherwise successful announcement. */
class AnnouncementAbandoned extends Schema.TaggedError<AnnouncementAbandoned>()(
  'AnnouncementAbandoned',
  { topic: Schema.String },
  { title: 'Abandoned test announcement' },
) {}

/**
 * Native proof T8 isolates the complete pool subtree with Layer.fresh (rc.116 Layer.ts:3891).
 * The socket/pool clock stays live as in testdb; the suite's client cannot mask a second checkout.
 */
const singleConnectionLayer = Layer.unwrap(
  Config.Redacted('VIVID_TEST_DATABASE_URL').pipe(
    Effect.map((url) => pgClientLayer({ url, maxConnections: 1, types: postgresCodecs() })),
  ),
).pipe(Layer.provide(Layer.succeed(Clock.Clock, Clock.Clock.defaultValue())))

/** A later committed marker bounds observation without waiting for the absence of a notice. */
const announcedBefore = Effect.fn('ChangesTest.announcedBefore')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
  marker: string,
) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))
  const batches = yield* Stream.fromQueue(notifications).pipe(
    Stream.takeWhile((notification) => notification.payload !== marker),
    Stream.mapEffect((notification) => decode(notification.payload)),
    Stream.runCollect,
  )
  return batches
})

describe.skipIf(!testDatabaseConfigured)('Transactional changes', () => {
  layer(testDatabaseLayer)((it) => {
    /** JSON quotes, escapes and UTF-8 all count toward PostgreSQL's strict 8000-byte ceiling. */
    it.effect('accepts 7999 bytes and refuses 8000 bytes before announcing anything', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const identifier = `${'😀'.repeat(1997)}"\\x`
        const accepted = [Topic.person(PersonId.make(identifier))]
        const refused = [Topic.person(PersonId.make(`${identifier}x`))]
        expect(Buffer.byteLength(JSON.stringify(accepted))).toBe(7999)
        expect(Buffer.byteLength(JSON.stringify(refused))).toBe(8000)
        yield* database.transaction((transaction) => announce(transaction, accepted))
        expect((yield* Queue.take(notifications)).payload).toBe(JSON.stringify(accepted))
        const split = [...accepted, Topic.person(PersonId.make('tail'))]
        yield* database.transaction((transaction) => announce(transaction, split))
        const splitMarker = [Topic.person(PersonId.make(crypto.randomUUID()))]
        yield* database.transaction((transaction) => announce(transaction, splitMarker))
        expect((yield* announcedBefore(notifications, JSON.stringify(splitMarker))).flat()).toEqual(
          split,
        )
        const failure = yield* database
          .transaction((transaction) => announce(transaction, refused))
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(DatabaseFailure)
        const marker = [Topic.person(PersonId.make(crypto.randomUUID()))]
        yield* database.transaction((transaction) => announce(transaction, marker))
        expect((yield* Queue.take(notifications)).payload).toBe(JSON.stringify(marker))
      }).pipe(Effect.scoped),
    )

    /** A later marker closes observation even when an oversized publish was silently dropped. */
    it.effect('publishes every UTF-8 owner before the next committed marker', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(changesLayer)
        return yield* Effect.gen(function* () {
          const database = yield* Database
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          const changes = yield* Changes
          const topics = [0, 1, 2].map((index) =>
            Topic.part('activity')(Topic.person(PersonId.make(`${'😀'.repeat(1200)}"${index}`))),
          )
          yield* changes.publish(topics)
          const marker = [Topic.person(PersonId.make(crypto.randomUUID()))]
          yield* database.transaction((transaction) => announce(transaction, marker))
          const batches = yield* announcedBefore(notifications, JSON.stringify(marker))
          expect(batches.flat()).toEqual(topics)
          expect(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) < 8000)).toBe(
            true,
          )
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )

    /** Wide audiences must reach PostgreSQL in bounded payloads, retaining every affected owner. */
    it.effect('announces every owner when an audience exceeds one PostgreSQL payload', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const topics = Array.from({ length: 400 }, () =>
          Topic.person(PersonId.make(crypto.randomUUID())),
        )
        const markerTopic = Topic.person(PersonId.make(crypto.randomUUID()))
        const marker = [markerTopic]
        yield* database.transaction((transaction) => announce(transaction, topics))
        yield* database.transaction((transaction) => announce(transaction, marker))
        const batches = yield* announcedBefore(notifications, JSON.stringify(marker))
        expect(batches.length).toBeGreaterThan(1)
        expect(batches.length).toBeLessThanOrEqual(3)
        expect(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) < 8000)).toBe(true)
        expect(batches.flat()).toEqual(topics)
      }).pipe(Effect.scoped),
    )

    /** Branded identifiers are strings, so the budget must count encoded UTF-8 bytes and JSON escapes. */
    it.effect('splits by UTF-8 payload bytes rather than topic count or character count', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const topics = [0, 1, 2].map((index) =>
          Topic.person(PersonId.make(`${'😀'.repeat(1_200)}"${index}`)),
        )
        const marker = [Topic.person(PersonId.make(crypto.randomUUID()))]
        yield* database.transaction((transaction) => announce(transaction, topics))
        yield* database.transaction((transaction) => announce(transaction, marker))
        expect((yield* announcedBefore(notifications, JSON.stringify(marker))).flat()).toEqual(
          topics,
        )
      }).pipe(Effect.scoped),
    )

    /**
     * One unrepresentable owner refuses the whole audience. The pre-check also prevents chop
     * from hanging on that owner; a distinct committed marker exposes any earlier notice.
     */
    it.effect(
      'refuses an audience with an unrepresentable owner and announces nothing from it',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          const earlierTopic = Topic.person(PersonId.make(crypto.randomUUID()))
          const markerTopic = Topic.person(PersonId.make(crypto.randomUUID()))
          const marker = [markerTopic]
          const failure = yield* database
            .transaction((transaction) =>
              announce(transaction, [earlierTopic, Topic.person(PersonId.make('x'.repeat(8_000)))]),
            )
            .pipe(Effect.flip)
          expect(failure).toBeInstanceOf(DatabaseFailure)
          yield* database.transaction((transaction) => announce(transaction, marker))
          expect((yield* Queue.take(notifications)).payload).toBe(JSON.stringify(marker))
        }).pipe(Effect.scoped),
    )

    /** An ordered committed marker proves rollback emitted nothing without waiting for absence. */
    it.effect('emits only the committed announcement to a PostgreSQL listener', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const sql = yield* PgClient
        // PgClient.ts:228-231 returns only after PostgreSQL confirms this channel's LISTEN.
        const notifications = yield* sql.listen(CHANNEL)
        const abandoned = Topic.person(PersonId.make(crypto.randomUUID()))
        const committed = Topic.person(PersonId.make(crypto.randomUUID()))
        const failure = yield* database
          .transaction((transaction) =>
            announce(transaction, [abandoned]).pipe(
              Effect.andThen(Effect.fail(new AnnouncementAbandoned({ topic: abandoned }))),
            ),
          )
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(AnnouncementAbandoned)
        yield* database.transaction((transaction) => announce(transaction, [committed]))
        expect((yield* Queue.take(notifications)).payload).toBe(JSON.stringify([committed]))
      }).pipe(Effect.scoped),
    )

    /** A committed announcement reaches a subscriber through the real PostgreSQL bus and hub. */
    it.effect('delivers a transaction announcement through Changes.subscribe', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(changesLayer)
        return yield* Effect.gen(function* () {
          const database = yield* Database
          const changes = yield* Changes
          const topic = Topic.person(PersonId.make(crypto.randomUUID()))
          const subscription = yield* changes.subscribe([topic], everyPart)
          yield* database.transaction((transaction) => announce(transaction, [topic]))
          expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )

    /** Kill only this test's uniquely named listener. The driver's failure log is the restart
     * signal; EVERYTHING is the confirmed re-LISTEN receipt before a second real publish. */
    it.effect(
      'resumes subscriber delivery after pg_terminate_backend kills its LISTEN connection',
      () =>
        Effect.gen(function* () {
          const applicationName = `listen-recovery-${crypto.randomUUID()}`
          const failures = yield* Queue.unbounded<string>()
          const capture = Logger.make(({ message, logLevel }) => {
            if (JSON.stringify(message).toLowerCase().includes('listener'))
              Queue.offerUnsafe(failures, logLevel)
          })
          const listenerClient = Layer.unwrap(
            Config.Redacted('VIVID_TEST_DATABASE_URL').pipe(
              Effect.map((url) => pgClientLayer({ url, applicationName, types: postgresCodecs() })),
            ),
          ).pipe(Layer.provide(Layer.succeed(Clock.Clock, Clock.Clock.defaultValue())))
          const context = yield* Layer.build(
            changesLayer.pipe(
              Layer.provide(listenerClient),
              Layer.provide(Logger.layer([capture])),
            ),
          )
          const changes = yield* Effect.provide(Changes, context)
          const topic = Topic.person(PersonId.make(crypto.randomUUID()))
          const notices = yield* Queue.unbounded<void>()
          const subscription = yield* changes.subscribe([topic], everyPart)
          yield* Stream.runForEach(subscription, () => Queue.offer(notices, undefined)).pipe(
            Effect.forkScoped,
          )
          // Startup readiness must prevent a publish immediately after acquisition from being lost.
          yield* changes.publish([topic])
          yield* Queue.take(notices)
          const sql = yield* SqlClient.SqlClient
          const killed = yield* sql<{ stopped: boolean }>`
          SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${applicationName}
          AND query ILIKE 'LISTEN%'
        `
          expect(killed).toEqual([{ stopped: true }])
          expect(yield* Queue.take(failures)).toBe('Error')
          yield* TestClock.adjust('2 seconds')
          yield* Queue.take(notices)
          yield* changes.publish([topic])
          yield* Queue.take(notices)
          expect(yield* Queue.size(notices)).toBe(0)
        }).pipe(Effect.scoped),
    )

    /**
     * A Thread shared with a few hundred People names more topics than one PostgreSQL payload
     * holds (8000 bytes). The last owner named is the one a single rejected payload would lose.
     */
    it.effect('delivers a publish that names more owners than one payload holds', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(changesLayer)
        return yield* Effect.gen(function* () {
          const changes = yield* Changes
          const audience = Array.from({ length: 400 }, () =>
            Topic.part('activity')(Topic.person(PersonId.make(crypto.randomUUID()))),
          )
          const last = audience.slice(-1)
          const subscription = yield* changes.subscribe(last, ['activity'])
          yield* changes.publish(audience)
          expect(Option.isSome(yield* Stream.runHead(subscription))).toBe(true)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )

    /**
     * Use the public Drizzle factory that Database itself wraps: its production Layer fixes pool
     * sizing. effect-postgres/session.js:24-29 pins this client's sole connection for transaction;
     * announcing must finish on it, without PgClient.notify's separate checkout (:256-263).
     */
    it.effect('announces inside a Drizzle transaction with a fresh one-connection pool', () =>
      Effect.gen(function* () {
        const suiteClient = yield* SqlClient.SqlClient
        const context = yield* Layer.build(Layer.fresh(singleConnectionLayer))
        return yield* Effect.gen(function* () {
          const client = yield* SqlClient.SqlClient
          expect(client).not.toBe(suiteClient)
          const database = yield* makeDrizzle()
          expect(database.$client).toBe(client)
          yield* database.transaction((transaction) =>
            announce(transaction, [Topic.person(PersonId.make(crypto.randomUUID()))]),
          )
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )
  })
})
