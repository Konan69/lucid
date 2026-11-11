import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import {
  type ApprovalId,
  DatabaseFailure,
  NotifyPersonOutcome,
  NotificationId,
  type CompanyId,
  type NotificationKind,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { notifications } from '../notifications/tables.ts'
import { Push } from '../push/delivery.ts'
import { PushTargets } from '../push/targets.ts'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import { NotificationDelivery, notificationDelivery } from './delivery.ts'

/** Store the notice and each channel obligation in the caller's product transaction. */
export const oweNotice = Effect.fn('Notifier.owe')(function* (input: {
  readonly id: NotificationId
  readonly notice: Notice
}) {
  const database = yield* Database
  const queue = yield* notificationDelivery
  const targets = yield* PushTargets
  const { notice } = input
  return yield* database
    .transaction((tx) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const inserted = yield* tx
          .insert(notifications)
          .values({
            id: input.id,
            personId: notice.personId,
            companyId: notice.companyId,
            kind: notice.kind,
            title: notice.title,
            body: notice.body,
            previewUrl: notice.previewUrl,
            conversationId: notice.threadId,
            approvalId: notice.approvalId,
            createdAt: now,
            readAt: null,
          })
          .onConflictDoNothing({ target: notifications.id })
          .returning({ id: notifications.id })
        if (inserted.length === 0) return true
        yield* queue.offer(
          NotificationDelivery.cases.Publish.make({
            personId: notice.personId,
            notificationId: input.id,
          }),
          {
            id: `${input.id}:publish`,
          },
        )
        for (const target of yield* targets.active(notice.personId)) {
          yield* queue.offer(
            NotificationDelivery.cases.Push.make({
              notificationId: input.id,
              personId: notice.personId,
              targetId: target.id,
            }),
            { id: `${input.id}:push:${target.id}` },
          )
        }
        return true
      }),
    )
    .pipe(
      Effect.catchTag(['PersistedQueueError', 'SchemaError'], () =>
        Effect.fail(new DatabaseFailure({ message: 'Notification delivery could not be owed.' })),
      ),
    )
})

/** The direct tool keeps its existing push result; durable jobs repay any interrupted attempt. */
export const recordNotice = Effect.fn('Notifier.record')(function* (input: {
  readonly id: NotificationId
  readonly notice: Notice
}) {
  yield* oweNotice(input)
  const push = yield* Push
  const outcome = yield* push
    .deliver(input.notice.personId, input.id)
    .pipe(
      Effect.catchTag('NotFound', () =>
        Effect.fail(new DatabaseFailure({ message: 'Written Notification is missing.' })),
      ),
    )
  return NotifyPersonOutcome.cases.Created.make({ notificationId: input.id, push: outcome })
})

/** One thing a Person should be told about. `companyId` is the workspace it happened in. */
export interface Notice {
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly kind: typeof NotificationKind.Type
  readonly title: string
  readonly body: string
  readonly previewUrl?: string
  readonly threadId: ThreadId | null
  /** The Approval the notice asks the Person to decide; null when it asks nothing of its own. */
  readonly approvalId: ApprovalId | null
}

export interface NotifierService {
  /**
   * Tells one Person something happened: stores the notification and wakes their open clients.
   * Device registration controls push delivery; every notice remains available in the inbox.
   */
  readonly notify: (
    notice: Notice & { readonly id: NotificationId },
  ) => Effect.Effect<void, DatabaseInfrastructureError>
}

/** Implemented in `notifications/notifier.ts` by `notifierLayer`. */
export class Notifier extends Context.Service<Notifier, NotifierService>()('vivid/Notifier') {}

/** Settings are recipient-wide: a missing row means the documented default, notifications enabled. */
export const notifierLayer = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const database = yield* Database
    const targets = yield* PushTargets
    const factory = yield* PersistedQueue.PersistedQueueFactory
    /** The caller owns identity so retries and joined answers owe the same notification. */
    const notify = Effect.fn('Notifier.notify')(function* (
      notice: Parameters<NotifierService['notify']>[0],
    ) {
      yield* oweNotice({ id: notice.id, notice }).pipe(
        // Preserve the caller's SQL transaction service while restoring stable authorities.
        Effect.provideService(Database, database),
        Effect.provideService(PushTargets, targets),
        Effect.provideService(PersistedQueue.PersistedQueueFactory, factory),
      )
    })
    return Notifier.of({ notify })
  }),
)
