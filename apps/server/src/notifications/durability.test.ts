import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Ref, Schema } from 'effect'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { NotificationId, PushDestination } from '@vivid/contracts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { fixture, pushTestLayer, PushProbe } from '../push/testing.ts'
import { PushTargets } from '../push/targets.ts'
import { pushDeliveries } from '../push/tables.ts'
import { threads } from '../threads/tables.ts'
import { NotificationDelivery, notificationDelivery, takeNotification } from './delivery.ts'
import { oweNotice, recordNotice } from './notifier.ts'
import { notifications } from './tables.ts'
import { CHANNEL, Topic } from '../live/changes.ts'
import { payload, silent } from '../live/testing.ts'

class Abandoned extends Schema.TaggedError<Abandoned>()(
  'Abandoned',
  {},
  { title: 'Notification test abandoned' },
) {}

const noticeTable = `notice_${crypto.randomUUID().replaceAll('-', '')}`

/** A separate SDK table prevents other suites' outstanding notices entering this consumer. */
const deliveryLayer = Layer.fresh(
  PersistedQueue.layer.pipe(
    Layer.provide(PersistedQueue.layerStoreSql({ tableName: noticeTable })),
  ),
).pipe(Layer.provideMerge(pushTestLayer))

describe.skipIf(!testDatabaseConfigured)('durable notification delivery', () => {
  layer(deliveryLayer)((it) => {
    it.effect('announces a notice once across producer and Publish replays', () =>
      Effect.gen(function* () {
        const owner = yield* fixture()
        const id = NotificationId.make(crypto.randomUUID())
        const notice = {
          personId: owner.person.id,
          companyId: null,
          kind: 'needs-you' as const,
          title: 'One announcement',
          body: 'Review it.',
          threadId: owner.threadId,
        }
        const heard = yield* (yield* PgClient).listen(CHANNEL)
        yield* oweNotice({ id, notice })
        yield* takeNotification()
        yield* payload(heard, [Topic.part('notifications')(Topic.person(owner.person.id))])
        const queue = yield* notificationDelivery
        // A distinct queue receipt simulates losing acknowledgement after a successful publish.
        yield* queue.offer(
          NotificationDelivery.cases.Publish.make({
            personId: owner.person.id,
            notificationId: id,
          }),
          { id: `${id}:replay` },
        )
        yield* takeNotification()
        yield* oweNotice({ id, notice })
        yield* silent(heard)
      }),
    )

    it.effect('concurrent recordNotice writers own one notice and one device send', () =>
      Effect.gen(function* () {
        const probe = yield* PushProbe
        yield* Effect.addFinalizer(() => Ref.set(probe.sent, []))
        const owner = yield* fixture()
        yield* (yield* PushTargets).register({
          personId: owner.person.id,
          sessionId: owner.sessionId,
          destination: owner.destination,
        })
        const id = NotificationId.make(crypto.randomUUID())
        const input = {
          id,
          notice: {
            personId: owner.person.id,
            companyId: null,
            kind: 'needs-you' as const,
            title: 'Concurrent notice',
            body: 'Review it.',
            threadId: owner.threadId,
          },
        }
        const results = yield* Effect.all([recordNotice(input), recordNotice(input)], {
          concurrency: 'unbounded',
        })
        expect(results.map((result) => result._tag)).toEqual(['Created', 'Created'])
        expect(
          yield* owner.database.run(
            owner.database.select().from(notifications).where(eq(notifications.id, id)),
          ),
        ).toHaveLength(1)
        const sql = yield* PgClient
        expect(
          yield* sql`SELECT id FROM ${sql(noticeTable)} WHERE id = ${`${id}:publish`}`,
        ).toHaveLength(1)
        expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(1)
        yield* takeNotification()
        yield* takeNotification()
        expect(yield* Ref.get((yield* PushProbe).sent)).toHaveLength(1)
      }),
    )

    it.effect('the final failed Publish attempt becomes a terminal failed job', () =>
      Effect.gen(function* () {
        const owner = yield* fixture()
        const sql = yield* PgClient
        const id = NotificationId.make(crypto.randomUUID())
        const constraint = `poison_${crypto.randomUUID().replaceAll('-', '')}`
        yield* Effect.addFinalizer(() =>
          sql
            .unsafe(`ALTER TABLE vivid_notifications DROP CONSTRAINT IF EXISTS ${constraint}`)
            .pipe(Effect.orDie),
        )
        // Only this UUID fails the real publication write; other suites keep their own rows.
        yield* sql.unsafe(
          `ALTER TABLE vivid_notifications ADD CONSTRAINT ${constraint} CHECK (id <> '${id}' OR published_at IS NULL)`,
        )
        yield* oweNotice({
          id,
          notice: {
            personId: owner.person.id,
            companyId: null,
            kind: 'needs-you',
            title: 'Poisoned publication',
            body: 'Review it.',
            threadId: owner.threadId,
          },
        })
        // Persist nine prior claims, as a restarted worker would find them, without waiting out backoff.
        yield* sql`UPDATE ${sql(noticeTable)} SET attempts = 9 WHERE id = ${`${id}:publish`}`
        yield* takeNotification().pipe(Effect.exit)
        const rows = yield* sql`SELECT state, attempts, last_failure FROM ${sql(noticeTable)}
          WHERE id = ${`${id}:publish`}`
        expect(rows).toMatchObject([{ state: 'failed', attempts: 10 }])
        expect(rows).toHaveLength(1)
        for (const row of rows) expect(row.last_failure).toBeTruthy()
      }),
    )

    it.effect(
      'rolls back product and obligations together, then replays devices independently',
      () =>
        Effect.gen(function* () {
          const owner = yield* fixture()
          const sql = yield* PgClient
          const targets = yield* PushTargets
          const browser = yield* targets.register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: owner.destination,
          })
          const phone = yield* targets.register({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            destination: PushDestination.cases.Phone.make({
              token: `ExpoPushToken[${crypto.randomUUID()}]`,
            }),
          })
          const id = NotificationId.make(crypto.randomUUID())
          const notice = {
            personId: owner.person.id,
            companyId: null,
            kind: 'needs-you' as const,
            title: 'Committed work',
            body: 'Review it.',
            threadId: owner.threadId,
          }
          const write = owner.database.transaction(() =>
            Effect.gen(function* () {
              yield* owner.database.run(
                owner.database
                  .update(threads)
                  .set({ title: notice.title })
                  .where(eq(threads.id, owner.threadId)),
              )
              yield* oweNotice({ id, notice })
            }),
          )
          const before = yield* owner.database.run(
            owner.database
              .select({ title: threads.title })
              .from(threads)
              .where(eq(threads.id, owner.threadId)),
          )
          yield* owner.database
            .transaction(() => write.pipe(Effect.andThen(Effect.fail(new Abandoned({})))))
            .pipe(Effect.catchTag('Abandoned', () => Effect.void))
          expect(
            yield* owner.database.run(
              owner.database.select().from(notifications).where(eq(notifications.id, id)),
            ),
          ).toEqual([])
          expect(
            yield* owner.database.run(
              owner.database
                .select({ title: threads.title })
                .from(threads)
                .where(eq(threads.id, owner.threadId)),
            ),
          ).toEqual(before)
          expect(
            yield* sql`SELECT id FROM ${sql(noticeTable)} WHERE queue_name = 'notification-delivery' AND id LIKE ${`${id}:%`}`,
          ).toEqual([])
          yield* write
          expect(yield* Ref.get((yield* PushProbe).sent)).toEqual([])
          // The producer is finished. A fresh queue instance consumes the SQL obligations.
          const queue = yield* notificationDelivery
          yield* queue.take(() => Effect.interrupt).pipe(Effect.exit)
          yield* takeNotification()
          const probe = yield* PushProbe
          yield* Ref.set(probe.mode, 'Uncertain')
          yield* takeNotification()
          yield* Ref.set(probe.mode, 'Browser')
          yield* takeNotification()
          const receipts = yield* owner.database.run(
            owner.database
              .select()
              .from(pushDeliveries)
              .where(eq(pushDeliveries.notificationId, id)),
          )
          expect(receipts).toHaveLength(2)
          expect(receipts.map(({ targetId }) => targetId).toSorted()).toEqual(
            [browser.id, phone.id].toSorted(),
          )
          expect(receipts.map(({ receipt }) => receipt._tag).toSorted()).toEqual(['Failed', 'Sent'])
          // Replaying the producer cannot create another obligation or resend an uncertain device.
          yield* oweNotice({ id, notice })
          expect(yield* Ref.get(probe.sent)).toHaveLength(2)
        }),
    )
  })
})
