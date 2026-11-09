import { and, eq, isNull } from 'drizzle-orm'
import { Cause, Clock, Effect, Layer, Schedule, Schema } from 'effect'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { NotificationId, PersonId, PushTargetId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { notifications } from './tables.ts'
import { deliverTarget } from '../push/delivery.ts'

/** Each client publication and device has independent SQL ownership, retries and acknowledgement. */
export const NotificationDelivery = Schema.TaggedUnion({
  Publish: { notificationId: NotificationId, personId: PersonId },
  Push: { notificationId: NotificationId, personId: PersonId, targetId: PushTargetId },
})

/**
 * Source-verified in Effect 4.0.2 PersistedQueue: layerStoreSql captures the shared SqlClient;
 * offer joins its fiber transaction, and take acknowledges only success. SQL polling covers
 * the process-local offer wake preceding commit. The existing push ledger fences uncertain
 * external sends across retries. Retain debts through the SDK's int32 attempt ceiling.
 */
export const notificationDelivery = PersistedQueue.make({
  name: 'notification-delivery',
  schema: NotificationDelivery,
  maxAttempts: 2147483647,
  retrySchedule: Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('5 minutes')]),
})

/** The publication receipt and NOTIFY share one commit, including across queue replays. */
export const takeNotification = Effect.fn('Notifications.take')(function* () {
  const queue = yield* notificationDelivery
  const database = yield* Database
  return yield* queue.take((job) =>
    NotificationDelivery.match(job, {
      Publish: ({ notificationId, personId }) =>
        database.transaction((tx) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const claimed = yield* tx
              .update(notifications)
              .set({ publishedAt: now })
              .where(and(eq(notifications.id, notificationId), isNull(notifications.publishedAt)))
              .returning({ id: notifications.id })
            if (claimed.length === 0) return
            yield* announce(tx, [Topic.part('notifications')(Topic.person(personId))])
          }),
        ),
      Push: (target) => deliverTarget(target),
    }),
  )
})

/** SDK finalizers retry each failed item; this scope also restarts a failed SQL consumer. */
export const notificationDeliveryLayer = Layer.effectDiscard(
  takeNotification().pipe(
    Effect.forever,
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.logWarning('Notification delivery consumer failed; restarting'),
    ),
    Effect.repeat(Schedule.spaced('500 millis')),
    Effect.forkScoped,
  ),
)
