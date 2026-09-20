import * as Effect from 'effect/Effect'
import { NotificationListResponse, NotificationReadResponse } from '@vivid/contracts'
import { TaskStore } from '../tasks/store.ts'

export const notificationHandlers = {
  ListNotifications: Effect.fn('Rpc.ListNotifications')(function* () {
    const store = yield* TaskStore
    const [notifications, unreadCount] = yield* Effect.all([store.listNotifications(), store.unreadNotificationCount()])
    return NotificationListResponse.make({ notifications, unreadCount })
  }),
  ReadNotifications: Effect.fn('Rpc.ReadNotifications')(function* ({ ids }) {
    const store = yield* TaskStore
    const changed = yield* store.markNotificationsRead(ids)
    return NotificationReadResponse.make({ changed, unreadCount: yield* store.unreadNotificationCount() })
  }),
}
