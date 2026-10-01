import * as Effect from 'effect/Effect'
import { NotificationReadResponse, type ReadNotificationsRequest } from '@vivid/contracts'
import { requireActor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { NotificationStore } from './store.ts'

export const notificationHandlers = {
  /** List and Watch share one recipient/workspace projection. */
  ListNotifications: Effect.fn('Rpc.ListNotifications')(function* () {
    return yield* (yield* NotificationStore).list(yield* requireActor())
  }),
  /** Workspace changes re-scope the subscription through the shared live-query authority. */
  WatchNotifications: () =>
    live((actor) => Effect.flatMap(NotificationStore, (store) => store.list(actor))),
  /** Publish only after the recipient's read markers have committed. */
  ReadNotifications: Effect.fn('Rpc.ReadNotifications')(function* (
    request: typeof ReadNotificationsRequest.Type,
  ) {
    const actor = yield* requireActor()
    const store = yield* NotificationStore
    const count = yield* store.read(actor, request)
    yield* changed(actor)
    return NotificationReadResponse.make({
      changed: count,
      unreadCount: yield* store.unreadCount(actor),
    })
  }),
}
