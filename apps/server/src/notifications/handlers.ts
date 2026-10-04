import * as Effect from 'effect/Effect'
import type { ReadNotificationsRequest } from '@vivid/contracts'
import { requireActor } from '../auth/access.ts'
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
  /** The store commits the markers, their count and the recipient's notice together. */
  ReadNotifications: Effect.fn('Rpc.ReadNotifications')(function* (
    request: typeof ReadNotificationsRequest.Type,
  ) {
    return yield* (yield* NotificationStore).read(yield* requireActor(), request)
  }),
}
