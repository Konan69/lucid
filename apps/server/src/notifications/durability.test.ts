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
import { notificationDelivery, takeNotification } from './delivery.ts'
import { oweNotice } from './notifier.ts'
import { notifications } from './tables.ts'

class Abandoned extends Schema.TaggedError<Abandoned>()(
  'Abandoned',
  {},
  { title: 'Notification test abandoned' },
) {}

const noticeTable = `notice_${crypto.randomUUID().replaceAll('-', '')}`

/** A separate SDK table prevents other suites' outstanding notices entering this consumer. */
const deliveryLayer = PersistedQueue.layer.pipe(
  Layer.provide(
    PersistedQueue.layerStoreSql({
      tableName: noticeTable,
    }),
  ),
  Layer.provideMerge(pushTestLayer),
)

describe.skipIf(!testDatabaseConfigured)('durable notification delivery', () => {
  layer(deliveryLayer)((it) => {
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
            approvalId: null,
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
            yield* sql`SELECT id FROM ${sql(noticeTable)} WHERE queue_name = 'notification-delivery'`,
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
