import { describe, expect, layer } from '@effect/vitest'
import { NotificationId, RunId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { fixture, pushTestLayer } from '../push/testing.ts'
import { Settlement } from '../runtime/settlement.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { RunStore } from '../threads/runs.ts'
import {
  NotificationDelivery,
  notificationDelivery,
  oweRunNotice,
  takeNotification,
} from './delivery.ts'
import { notifierLayer } from './notifier.ts'
import { notifications } from './tables.ts'

/** This consumer cannot claim another suite's outstanding notices, including after a failed repro. */
const deliveryLayer = PersistedQueue.layer.pipe(
  Layer.provide(
    PersistedQueue.layerStoreSql({
      tableName: `settlement_${crypto.randomUUID().replaceAll('-', '')}`,
    }),
  ),
  Layer.provideMerge(pushTestLayer),
)

describe.skipIf(!testDatabaseConfigured)('settlement notification identity', () => {
  layer(notifierLayer.pipe(Layer.provideMerge(deliveryLayer)))((it) => {
    it.effect('joined submissions and their notice retries produce one notice per answer', () =>
      Effect.gen(function* () {
        const owner = yield* fixture()
        const store = yield* RunStore
        const submissions = [RunId.make(crypto.randomUUID()), RunId.make(crypto.randomUUID())]
        for (const id of submissions)
          yield* store.start({
            id,
            threadId: owner.threadId,
            personId: owner.person.id,
            origin: StoredRunOrigin.cases.Message.make({}),
          })
        const settlement = Settlement.cases.Completed.make({
          responseId: RunId.make(crypto.randomUUID()),
          reply: 'One shared answer.',
        })
        const notices = submissions.map((runId) => ({
          runId,
          threadId: owner.threadId,
          personId: owner.person.id,
          settlement,
        }))
        yield* Effect.forEach(notices, oweRunNotice, { concurrency: 'unbounded' })
        const queue = yield* notificationDelivery
        for (const run of notices)
          yield* queue.offer(
            NotificationDelivery.cases.OweRun.make({
              notificationId: NotificationId.make(`${run.runId}:finished`),
              run,
            }),
          )
        // One publication and both deferred retries must retain the shared answer's identity.
        yield* takeNotification().pipe(Effect.repeat({ times: 2 }))
        const rows = yield* owner.database.run(
          owner.database
            .select()
            .from(notifications)
            .where(eq(notifications.personId, owner.person.id)),
        )
        expect(rows).toHaveLength(1)
        expect(rows).toMatchObject([{ body: settlement.reply, conversationId: owner.threadId }])
        const nextAnswer = Settlement.cases.Completed.make({
          responseId: RunId.make(crypto.randomUUID()),
          reply: settlement.reply,
        })
        yield* Effect.forEach(notices, (notice) =>
          oweRunNotice({ ...notice, settlement: nextAnswer }),
        )
        expect(
          yield* owner.database.run(
            owner.database
              .select()
              .from(notifications)
              .where(eq(notifications.personId, owner.person.id)),
          ),
        ).toHaveLength(2)
      }),
    )
  })
})
