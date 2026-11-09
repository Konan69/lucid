import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import { eq } from 'drizzle-orm'
import {
  DatabaseFailure,
  NotifyPersonOutcome,
  NotificationId,
  type CompanyId,
  type NotificationKind,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { settingsTable } from '../settings/tables.ts'
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
        const rows = yield* tx
          .select({ notify: settingsTable.notify })
          .from(settingsTable)
          .where(eq(settingsTable.personId, notice.personId))
          .limit(1)
        if (rows[0] !== undefined && !rows[0].notify) return false
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
            conversationId: notice.threadId,
            createdAt: now,
            readAt: null,
          })
          .onConflictDoNothing({ target: notifications.id })
          .returning({ id: notifications.id })
        if (inserted.length === 0) return true
        yield* queue.offer(NotificationDelivery.cases.Publish.make({
            personId: notice.personId,
            notificationId: input.id,
          }), {
          id: `${input.id}:publish`,
        })
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
  if (!(yield* oweNotice(input))) return NotifyPersonOutcome.cases.Disabled.make({})
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
  readonly threadId: ThreadId | null
}

export interface NotifierService {
  /**
   * Tells one Person something happened: stores the notification and wakes their open clients.
   * A Person who turned notifications off in Settings is not told; that is their choice and not an
   * error. Every other domain notifies through here and never writes the table itself.
   */
  readonly notify: (notice: Notice) => Effect.Effect<void, DatabaseInfrastructureError>
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
    /** A disabled preference suppresses storage and publication, so no unread record is left behind. */
    const notify = Effect.fn('Notifier.notify')(function* (notice: Notice) {
      yield* oweNotice({ id: NotificationId.make(crypto.randomUUID()), notice }).pipe(
        // Preserve the caller's SQL transaction service while restoring stable authorities.
        Effect.provideService(Database, database),
        Effect.provideService(PushTargets, targets),
        Effect.provideService(PersistedQueue.PersistedQueueFactory, factory),
      )
    })
    return Notifier.of({ notify })
  }),
)
