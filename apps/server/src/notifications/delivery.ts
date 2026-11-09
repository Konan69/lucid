import { and, eq, isNull } from 'drizzle-orm'
import { Cause, Clock, Effect, Layer, Option, Schedule, Schema } from 'effect'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { NotificationId, PersonId, PushTargetId, RunId, ThreadId } from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { notifications } from './tables.ts'
import { deliverTarget } from '../push/delivery.ts'
import { Settlement } from '../runtime/settlement.ts'
import { canSee, findThread } from '../threads/access.ts'
import { automaticallyNotifies } from '../threads/runs.ts'
import { notifiesFrom } from '../threads/place.ts'
import { Presence } from '../threads/presence.ts'
import { PushTargets } from '../push/targets.ts'
import { Notifier, oweNotice } from './notifier.ts'

/** A failed savepoint retains the Run's verdict so a later worker can recheck notice eligibility. */
const RunNotice = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  personId: PersonId,
  settlement: Settlement,
})

/** Settlement and retries share the same quiet-origin, presence and current-access rules. */
export const oweRunNotice = Effect.fn('Notifications.oweRun')(function* (
  run: typeof RunNotice.Type,
) {
  const thread = yield* findThread(run.threadId)
  if (Option.isNone(thread)) return
  const { settlement } = run
  const quiet =
    Settlement.guards.Completed(settlement) && !(yield* automaticallyNotifies(run.runId))
  if (quiet || Settlement.guards.Stopped(settlement) || !notifiesFrom(thread.value.place)) return
  if (yield* (yield* Presence).watching(run.threadId, run.personId)) return
  // A Run can outlast its Person's access. Never quote a Thread they can no longer read.
  if (!(yield* canSee(run.threadId, run.personId))) return
  yield* (yield* Notifier).notify({
    personId: run.personId,
    companyId: thread.value.companyId,
    kind: 'finished',
    title: thread.value.title,
    body: Settlement.guards.Completed(settlement)
      ? settlement.reply.slice(0, 240)
      : 'Vivid could not finish this.',
    threadId: run.threadId,
  })
})

/** Failed owing is repaid under one notice id even if the worker loses its acknowledgement. */
const retryRunNotice = Effect.fn('Notifications.retryRun')(function* (job: {
  readonly notificationId: NotificationId
  readonly run: typeof RunNotice.Type
}) {
  const context = yield* Effect.context<
    Database | PersistedQueue.PersistedQueueFactory | PushTargets
  >()
  return yield* oweRunNotice(job.run).pipe(
    Effect.provideService(
      Notifier,
      Notifier.of({
        notify: (notice) =>
          oweNotice({ id: job.notificationId, notice }).pipe(
            Effect.provideContext(context),
            Effect.asVoid,
          ),
      }),
    ),
  )
})

/** Each client publication and device has independent SQL ownership, retries and acknowledgement. */
export const NotificationDelivery = Schema.TaggedUnion({
  OweRun: { notificationId: NotificationId, run: RunNotice },
  Publish: { notificationId: NotificationId, personId: PersonId },
  Push: { notificationId: NotificationId, personId: PersonId, targetId: PushTargetId },
})

/**
 * Source-verified in Effect 4.0.2 PersistedQueue: layerStoreSql captures the shared SqlClient;
 * offer joins its fiber transaction, and take acknowledges only success. SQL polling covers
 * the process-local offer wake preceding commit. The existing push ledger fences uncertain
 * external sends across retries. Exhausted jobs remain in the SDK's terminal failed state.
 */
const DELIVERY_ATTEMPTS = 10

export const notificationDelivery = PersistedQueue.make({
  name: 'notification-delivery',
  schema: NotificationDelivery,
  maxAttempts: DELIVERY_ATTEMPTS,
  retrySchedule: Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('5 minutes')]),
})

/** A guarded receipt and NOTIFY either both commit or both remain owed. */
const publishNotice = Effect.fn('Notifications.publish')(function* (
  job: typeof NotificationDelivery.cases.Publish.Type,
) {
  const database = yield* Database
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const claimed = yield* tx
        .update(notifications)
        .set({ publishedAt: now })
        .where(and(eq(notifications.id, job.notificationId), isNull(notifications.publishedAt)))
        .returning({ id: notifications.id })
      if (claimed.length === 0) return
      yield* announce(tx, [Topic.part('notifications')(Topic.person(job.personId))])
    }),
  )
})

/** The publication receipt and NOTIFY share one commit, including across queue replays. */
export const takeNotification = Effect.fn('Notifications.take')(function* () {
  const queue = yield* notificationDelivery
  return yield* queue.take((job, metadata) =>
    NotificationDelivery.match<
      Effect.Effect<
        void,
        DatabaseInfrastructureError,
        Effect.Services<ReturnType<typeof retryRunNotice> | ReturnType<typeof deliverTarget>>
      >
    >(job, {
      OweRun: retryRunNotice,
      Publish: publishNotice,
      Push: deliverTarget,
    }).pipe(
      Effect.tapCause((cause) =>
        metadata.attempts >= DELIVERY_ATTEMPTS && !Cause.hasInterruptsOnly(cause)
          ? Effect.logError('Notification delivery exhausted its attempts', {
              noticeId: job.notificationId,
              attempts: metadata.attempts,
            })
          : Effect.void,
      ),
    ),
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
