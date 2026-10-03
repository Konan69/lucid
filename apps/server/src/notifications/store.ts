import { and, desc, inArray, isNull, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  Notification,
  NotificationListResponse,
  type ReadNotificationsRequest,
} from '@vivid/contracts'
import { ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { notifications } from '../notifications/tables.ts'

const decodeNotification = decodeStored(Notification, 'notification')

/** Notifications belong to their recipient, including in a Company; no role widens this scope. */
const makeStore = (database: Database['Service']) => {
  /** Counts all unread records in this workspace independently of the list's pagination limit. */
  const unreadCount = Effect.fn('NotificationStore.unreadCount')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(notifications)
        .where(and(ownedHere(notifications, actor), isNull(notifications.readAt))),
    )
    return (yield* returned(rows, 'notification count')).count
  })
  /** Returns the same scoped result for both List and Watch. */
  const list = Effect.fn('NotificationStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(notifications)
        .where(ownedHere(notifications, actor))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(50),
    )
    const views = yield* Effect.forEach(rows, (row) =>
      decodeNotification({ ...row, threadId: row.conversationId }),
    )
    return NotificationListResponse.make({
      notifications: views,
      unreadCount: yield* unreadCount(actor),
    })
  })
  /** A payload id can only mark the recipient's own notifications in their active workspace. */
  const read = Effect.fn('NotificationStore.read')(function* (
    actor: Actor,
    request: typeof ReadNotificationsRequest.Type,
  ) {
    if (request.ids !== undefined && request.ids.length === 0) return 0
    const now = yield* Clock.currentTimeMillis
    const selected = request.ids === undefined ? undefined : inArray(notifications.id, request.ids)
    const rows = yield* database.run(
      database
        .update(notifications)
        .set({ readAt: now })
        .where(and(ownedHere(notifications, actor), isNull(notifications.readAt), selected))
        .returning({ id: notifications.id }),
    )
    return rows.length
  })
  return { list, read, unreadCount }
}

export class NotificationStore extends Context.Service<
  NotificationStore,
  ReturnType<typeof makeStore>
>()('vivid/NotificationStore') {}

/** The store owns recipient-scoped persistence, while Notifier owns producing a notice. */
export const notificationStoreLayer = Layer.effect(
  NotificationStore,
  Effect.gen(function* () {
    return NotificationStore.of(makeStore(yield* Database))
  }),
)
