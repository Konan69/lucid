import { and, desc, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  Notification,
  NotificationListResponse,
  NotificationReadResponse,
  type ReadNotificationsRequest,
} from '@vivid/contracts'
import { ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { notifications } from '../notifications/tables.ts'
import { readableThread } from '../threads/access.ts'

const decodeNotification = decodeStored(Notification, 'notification')

/**
 * A recipient's notice in this workspace is shown only while its quoted Thread is readable now.
 * No-Thread notices keep their existing scope. Hidden rows survive, unread, for a later re-share;
 * list, count and both marking modes use this predicate before pagination or mutation.
 */
const shownTo = (actor: Actor): SQL =>
  sql`(${ownedHere(notifications, actor)} and (${isNull(notifications.conversationId)} or ${readableThread(notifications.conversationId, actor.person.id)}))`

/** Notifications belong to their recipient, including in a Company; no role widens this scope. */
const makeStore = (database: Database['Service']) => {
  /** Counts all unread records in this workspace independently of the list's pagination limit. */
  const unreadCount = Effect.fn('NotificationStore.unreadCount')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(notifications)
        .where(and(shownTo(actor), isNull(notifications.readAt))),
    )
    return (yield* returned(rows, 'notification count')).count
  })
  /** Returns the same scoped result for both List and Watch. */
  const list = Effect.fn('NotificationStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(notifications)
        .where(shownTo(actor))
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
  /**
   * shownTo keeps markers recipient/workspace scoped and excludes hidden Threads, even by id;
   * notifier.ts recordNotice uses the same recipient-only topic. Zero changed rows announce nothing.
   * Count after the update and before
   * announce so either failure rolls markers back; the reply is the count statement's view,
   * including our own marks, rather than a global snapshot at commit. Drizzle's
   * EffectPgSession.transaction (effect-postgres/session.js) and rc.116 SqlClient.ts make select
   * the fiber's writing connection even for unreadCount's root-database query.
   */
  const read = Effect.fn('NotificationStore.read')(function* (
    actor: Actor,
    request: typeof ReadNotificationsRequest.Type,
  ) {
    if (request.ids !== undefined && request.ids.length === 0)
      return NotificationReadResponse.make({ changed: 0, unreadCount: yield* unreadCount(actor) })
    const now = yield* Clock.currentTimeMillis
    const selected = request.ids === undefined ? undefined : inArray(notifications.id, request.ids)
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(notifications)
          .set({ readAt: now })
          .where(and(shownTo(actor), isNull(notifications.readAt), selected))
          .returning({ id: notifications.id })
        const unread = yield* unreadCount(actor)
        if (rows.length > 0) yield* announce(tx, [Topic.person(actor.person.id)])
        return NotificationReadResponse.make({ changed: rows.length, unreadCount: unread })
      }),
    )
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
