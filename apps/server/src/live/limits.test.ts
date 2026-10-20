import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { DatabaseFailure, PersonId } from '@vivid/contracts'
import { Effect, Layer, Queue, Schema, Stream } from 'effect'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic } from './changes.ts'

/** A committed marker bounds observation even when a prior publish silently emitted nothing. */
const announcedBefore = Effect.fn('LimitsTest.announcedBefore')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
  marker: string,
) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))
  return yield* Stream.fromQueue(notifications).pipe(
    Stream.takeWhile((notification) => notification.payload !== marker),
    Stream.mapEffect((notification) => decode(notification.payload)),
    Stream.runCollect,
  )
})

describe.skipIf(!testDatabaseConfigured)('Notification byte limits', () => {
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
  })
})
