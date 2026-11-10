import {
  InvitationId,
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
 *
 * It began in the web app (`apps/web/src/data/notices.ts`) and moved here when the phone got its
 * own notifications screen: the web's panel and the phone's screen list the same rows, say the
 * same words in them, and mark them read the same way; only how a row is drawn is each app's.
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

/** A notice as it is once read. Every field is named, so a new one cannot be dropped unseen. */
const readAt = (notice: Notification, at: number): Notification => ({
  id: notice.id,
  kind: notice.kind,
  title: notice.title,
  body: notice.body,
  threadId: notice.threadId,
  opens: notice.opens,
  createdAt: notice.createdAt,
  readAt: at,
})

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
        notice.readAt === null && reading.has(notice.id) ? readAt(notice, at) : notice,
      ),
      unreadCount: current.unreadCount - changed,
    }
  }

/** What the list looks like once "Mark all read" is accepted: nothing unread, here or beyond. */
export const everyNoticeRead =
  (at: number) =>
  (current: NotificationList): NotificationList => ({
    notifications: current.notifications.map((notice) =>
      notice.readAt === null ? readAt(notice, at) : notice,
    ),
    unreadCount: 0,
  })

/**
 * What each kind of notice is called when nothing better names it. A new kind fails to compile
 * here until it has a name.
 */
const NOTICE_NAME = {
  finished: 'Vivid finished',
  'needs-you': 'Vivid needs you',
  shared: 'A Thread was shared with you',
  invited: 'You were invited',
  posted: 'Vivid posted to your Feed',
} as const satisfies Record<Notification['kind'], string>

/**
 * What a notice is called when it leads its row. The server writes a title for every notice, but
 * the contract allows an empty one, and a row with a mark, a time and no words was found by
 * looking at the worst-case list: it could not be read or told apart. A notice without a title
 * is called by its kind, which it always has.
 */
const named = (notice: Notification): string =>
  notice.title.trim().length === 0 ? NOTICE_NAME[notice.kind] : notice.title

/** An invitation notice carries its id at the end of its body; the rest is the sentence. */
const INVITATION = /\s*invitation:(\S+)$/u

/** The invitation a notice is about, when its body carries one. */
export const invitationIn = (notice: Notification): Option.Option<InvitationId> =>
  Option.flatMap(Option.fromNullOr(INVITATION.exec(notice.body)), (found) =>
    Option.map(Option.fromUndefinedOr(found[1]), (id) => InvitationId.make(id)),
  )

/** What a row says, whichever kind of row it is, so both are drawn on the same edges. */
export interface NoticeFace {
  /** Stable while notices arrive and are read: the Thread for a group, the notice for a single. */
  readonly key: string
  /** The Thread's title, or the notice's own when there is no Thread title to lead with. */
  readonly heading: string
  /** The notice the mark, the line and the time are taken from: the newest one. */
  readonly notice: Notification
  /** The sentence under the heading: the notice's body without the marker it may end in. */
  readonly line: string
  /**
   * What the notice is, for someone who cannot see its mark, when the heading does not already
   * say it: a row led by a Thread's title carries its kind only in the colour of an icon.
   */
  readonly spoken: Option.Option<string>
  /** Whether the Thread is waiting on this Person now. */
  readonly waiting: boolean
  /** How many notices of the row are unread. */
  readonly unread: number
}

const lineOf = (notice: Notification) => notice.body.replace(INVITATION, '')

/** The words of one row. Web and phone draw these same words; neither decides them. */
export const noticeFace = NoticeRow.$match({
  Single: ({ notice }): NoticeFace => ({
    key: notice.id,
    heading: named(notice),
    notice,
    line: lineOf(notice),
    spoken: Option.none(),
    waiting: false,
    unread: notice.readAt === null ? 1 : 0,
  }),
  Grouped: ({ threadId, title, newest, waiting, unread }): NoticeFace => ({
    key: threadId,
    heading: Option.getOrElse(title, () => named(newest)),
    notice: newest,
    line: lineOf(newest),
    spoken: Option.map(title, () => newest.title),
    waiting,
    unread: unread.length,
  }),
})
