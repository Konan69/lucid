import { Schema } from 'effect'
import { NotificationId, ThreadId } from './identity.js'

/** Closed notification variants encoded by the current HTTP protocol. */
export const NotificationKind = Schema.Literals([
  /** Vivid finished a Run in a Thread this Person was not looking at. */
  'finished',
  /** A question or an Approval is waiting for this Person. */
  'needs-you',
  /** Someone shared a Thread with this Person. */
  'shared',
  /** This Person was invited to a Company. */
  'invited',
] as const)

/** Durable notification returned by the runtime. */
export const Notification = Schema.Struct({
  id: NotificationId,
  kind: NotificationKind,
  title: Schema.String,
  body: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.Number,
  readAt: Schema.NullOr(Schema.Number),
}).annotate({ identifier: 'Notification', title: 'Notification' })
/** Decoded notification. */
export interface Notification extends Schema.Schema.Type<typeof Notification> {}
/** Input for marking selected or all notifications read. */
export const ReadNotificationsRequest = Schema.Struct({
  ids: Schema.optionalKey(Schema.Array(NotificationId)),
})
/** Notification list response. */
export const NotificationListResponse = Schema.Struct({
  notifications: Schema.Array(Notification),
  unreadCount: Schema.Number,
})
/** Notification mutation response. */
export const NotificationReadResponse = Schema.Struct({
  changed: Schema.Number,
  unreadCount: Schema.Number,
})
