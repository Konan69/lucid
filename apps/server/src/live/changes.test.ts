import { PgClient, layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { makeWithDefaults as makeDrizzle } from 'drizzle-orm/effect-postgres'
import { Clock, Config, Effect, Layer, Option, Queue, Schema, Stream } from 'effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { PersonId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { postgresCodecs } from '../database/codecs.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic } from './changes.ts'

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

describe.skipIf(!testDatabaseConfigured)('Transactional changes', () => {
  layer(testDatabaseLayer)((it) => {
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
          const subscription = yield* changes.subscribe([topic])
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
