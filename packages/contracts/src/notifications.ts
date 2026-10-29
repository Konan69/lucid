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
  /** Vivid put something on the Feed from work nobody was watching (a Background Thread). */
  'posted',
] as const)

/**
 * Where a notice opens when the Person presses it, on every surface. The server derives it from
 * the notice's Thread: none is a Company invitation, read in Notifications; a Background Thread
 * is shown on the Feed (its posts, questions and Approvals are drawn there); any other Thread
 * opens itself. A client routes on it and never works it out again.
 */
export const NotificationOpens = Schema.TaggedUnion({
  Thread: { threadId: ThreadId },
  Feed: {},
  Notifications: {},
})
export type NotificationOpens = typeof NotificationOpens.Type

/** Durable notification returned by the runtime. */
export const Notification = Schema.Struct({
  id: NotificationId,
  kind: NotificationKind,
  title: Schema.String,
  body: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  opens: NotificationOpens,
  createdAt: Schema.Finite,
  readAt: Schema.NullOr(Schema.Finite),
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
  unreadCount: Schema.Finite,
})
/** Notification mutation response. */
export const NotificationReadResponse = Schema.Struct({
  changed: Schema.Finite,
  unreadCount: Schema.Finite,
})
