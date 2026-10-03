import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import { eq } from 'drizzle-orm'
import type { CompanyId, NotificationKind, PersonId, ThreadId } from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { settingsTable } from '../settings/tables.ts'
import { notifications } from '../notifications/tables.ts'

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
    const changes = yield* Changes
    /** A disabled preference suppresses storage and publication, so no unread record is left behind. */
    const notify = Effect.fn('Notifier.notify')(function* (notice: Notice) {
      const rows = yield* database.run(
        database
          .select({ notify: settingsTable.notify })
          .from(settingsTable)
          .where(eq(settingsTable.personId, notice.personId))
          .limit(1),
      )
      const preference = rows[0]
      if (preference !== undefined && !preference.notify) return
      const now = yield* Clock.currentTimeMillis
      yield* database.run(
        database.insert(notifications).values({
          id: crypto.randomUUID(),
          personId: notice.personId,
          companyId: notice.companyId,
          kind: notice.kind,
          title: notice.title,
          body: notice.body,
          conversationId: notice.threadId,
          createdAt: now,
          readAt: null,
        }),
      )
      yield* changes.publish([Topic.person(notice.personId)])
    })
    return Notifier.of({ notify })
  }),
)
