import {
  NotificationId,
  ThreadId,
  type Notification,
  type NotificationListResponse,
  type Thread,
} from '@vivid/contracts'
import { Array as Arr, Data, Option, Order } from 'effect'

/**
 * What the notifications panel lists: one row for each place to go, not one for each notice.
 *
 * Three questions asked in one Thread used to be three rows with the same heading, which read as
 * three things to do when it is one conversation to open. The rows are worked out here, away from
 * React, so the grouping, the order and the counts can be tested without drawing anything.
 */

export type NotificationList = typeof NotificationListResponse.Type

/** The part of a Thread a row needs: which one it is, what it is called, and whether it waits. */
export type NoticeThread = Pick<Thread, 'id' | 'title' | 'attention'>

/**
 * One row of the panel.
 *
 * - `Single`: a notice about no Thread (an invitation). It stands alone and keeps its own title.
 * - `Grouped`: every notice about one Thread, even when that is only one. `title` is the Thread's
 *   own title and is absent when the Thread is not in the Person's list (deleted, or no longer
 *   theirs to see) or has no title yet; the row then leads with the newest notice's title.
 *   `waiting` is the Thread's own state, not the kind of a notice: a question that was answered
 *   leaves its notice behind, and that notice must not say the Thread still needs the Person.
 *   `unread` is what one press marks read.
 */
export type NoticeRow = Data.TaggedEnum<{
  Single: { readonly notice: Notification }
  Grouped: {
    readonly threadId: ThreadId
    readonly title: Option.Option<string>
    readonly newest: Notification
    readonly waiting: boolean
    readonly unread: ReadonlyArray<NotificationId>
  }
}>
export const NoticeRow = Data.taggedEnum<NoticeRow>()

/** The notice a row is dated and ordered by. */
const latestOf = NoticeRow.$match({
  Single: ({ notice }) => notice,
  Grouped: ({ newest }) => newest,
})

/** Newest first, by the notice each row is dated by. */
const newestFirst: Order.Order<NoticeRow> = Order.mapInput(
  Order.flip(Order.Number),
  (row: NoticeRow) => latestOf(row).createdAt,
)

/** Every notice about one Thread as its row. `notices` is never empty: a group starts with one. */
const grouped = (
  threadId: ThreadId,
  notices: ReadonlyArray<Notification>,
  thread: Option.Option<NoticeThread>,
  first: Notification,
): NoticeRow =>
  NoticeRow.Grouped({
    threadId,
    // A Thread that has not been titled yet has nothing to lead with, so it is treated as one the
    // list does not name, not drawn as an empty heading.
    title: thread.pipe(
      Option.map((known) => known.title.trim()),
      Option.filter((title) => title !== ''),
    ),
    // On a tie the earlier one in the server's order stays, so the row does not flip between two
    // notices written in the same millisecond.
    newest: notices.reduce(
      (newest, next) => (next.createdAt > newest.createdAt ? next : newest),
      first,
    ),
    waiting: Option.exists(thread, (known) => known.attention === 'NeedsYou'),
    unread: notices.flatMap((notice) => (notice.readAt === null ? [notice.id] : [])),
  })

/**
 * The panel's rows: notices about the same Thread together, everything in one order of time.
 *
 * The order is by each row's newest notice and nothing else. Unread rows do not rise above newer
 * read ones, so a row stays where it is when it is read and the panel does not rearrange itself
 * under the pointer.
 */
export const noticeRows = (
  notices: ReadonlyArray<Notification>,
  threads: ReadonlyArray<NoticeThread>,
): ReadonlyArray<NoticeRow> => {
  const known = new Map(threads.map((thread) => [thread.id, thread]))
  const groups = new Map<ThreadId, Array<Notification>>()
  const rows: Array<NoticeRow> = []
  for (const notice of notices) {
    const threadId = notice.threadId
    if (threadId === null) {
      rows.push(NoticeRow.Single({ notice }))
      continue
    }
    const group = groups.get(threadId)
    if (group === undefined) groups.set(threadId, [notice])
    else group.push(notice)
  }
  for (const [threadId, group] of groups) {
    const first = group[0]
    if (first !== undefined) {
      rows.push(grouped(threadId, group, Option.fromNullishOr(known.get(threadId)), first))
    }
  }
  // `Arr.sort` is stable, so rows dated the same keep the order they were met in.
  return Arr.sort(rows, newestFirst)
}

/**
 * What the list looks like once these notices are read, for showing a press at once. The count
 * goes down by what actually changed: it is the server's count of everything unread, which can
 * be more than the notices in this window.
 */
export const noticesRead =
  (ids: ReadonlyArray<NotificationId>, at: number) =>
  (current: NotificationList): NotificationList => {
    const reading = new Set(ids)
    const changed = current.notifications.filter(
      (notice) => notice.readAt === null && reading.has(notice.id),
    ).length
    return {
      notifications: current.notifications.map((notice) =>
        notice.readAt === null && reading.has(notice.id) ? { ...notice, readAt: at } : notice,
      ),
      unreadCount: current.unreadCount - changed,
    }
  }

/** What the list looks like once "Mark all read" is accepted: nothing unread, here or beyond. */
export const everyNoticeRead =
  (at: number) =>
  (current: NotificationList): NotificationList => ({
    notifications: current.notifications.map((notice) =>
      notice.readAt === null ? { ...notice, readAt: at } : notice,
    ),
    unreadCount: 0,
  })
