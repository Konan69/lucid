import { PgClient, layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { makeWithDefaults as makeDrizzle } from 'drizzle-orm/effect-postgres'
import { Clock, Config, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'
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
