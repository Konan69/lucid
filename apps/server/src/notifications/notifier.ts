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
import { Changes, Topic } from '../live/changes.ts'
import { settingsTable } from '../settings/tables.ts'
import { notifications } from '../notifications/tables.ts'
import { Push } from '../push/delivery.ts'

/**
 * The Notification is committed before delivery. Repeating its id rereads the existing record;
 * the push ledger, not a caller's process memory, decides whether each target was already sent.
 */
export const recordNotice = Effect.fn('Notifier.record')(function* (input: {
  readonly id: NotificationId
  readonly notice: Notice
}) {
  const database = yield* Database
  const changes = yield* Changes
  const push = yield* Push
  const { notice } = input
  const rows = yield* database.run(
    database
      .select({ notify: settingsTable.notify })
      .from(settingsTable)
      .where(eq(settingsTable.personId, notice.personId))
      .limit(1),
  )
  const preference = rows[0]
  if (preference !== undefined && !preference.notify)
    return NotifyPersonOutcome.cases.Disabled.make({})
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database
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
      .onConflictDoNothing({ target: notifications.id }),
  )
  yield* changes.publish([Topic.person(notice.personId)])
  // A missing row after insertion is a persistence fault. Provider failures are receipts, while
  // an unsettled persistence write stays a failure and cannot authorize repeating an external send.
  const outcome = yield* push
    .deliver(notice.personId, input.id)
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
    const services = yield* Effect.context<Database | Changes | Push>()
    /** A disabled preference suppresses storage and publication, so no unread record is left behind. */
    const notify = Effect.fn('Notifier.notify')(function* (notice: Notice) {
      yield* recordNotice({ id: NotificationId.make(crypto.randomUUID()), notice }).pipe(
        Effect.provideContext(services),
      )
    })
    return Notifier.of({ notify })
  }),
)
