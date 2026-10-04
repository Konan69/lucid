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

/*
 * Worst-case data for the panel (the `break-ui` review of 4 October 2026).
 *
 * The panel was designed against three short questions. These are the lists a real Person
 * produces: one Thread that asked forty times, thirty Threads at once, a title with no space to
 * break at, a body that is one unbroken string, right-to-left and emoji titles, a Thread that was
 * deleted, and counts from one to a thousand. The panel offers them behind a switch that exists
 * only in a development build; nothing here is reached from a production one.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What a trial hands the panel in place of the live queries. */
export interface NoticeTrial {
  readonly notices: ReadonlyArray<Notification>
  readonly threads: ReadonlyArray<NoticeThread>
}

/** One trial notice. `place` makes its id, so every notice of a trial is a different one. */
const trialNotice = (place: string, at: number, changes: Partial<Notification>): Notification => ({
  id: NotificationId.make(`trial-${place}`),
  kind: 'needs-you',
  title: 'Vivid has a question',
  body: 'What takes up most of your day?',
  threadId: null,
  createdAt: at,
  readAt: null,
  ...changes,
})

/** `count` unread questions in one Thread, a minute apart, the newest at `at`. */
const asked = (thread: string, count: number, at: number): ReadonlyArray<Notification> =>
  Array.from({ length: count }, (_, place) =>
    trialNotice(`${thread}-${place}`, at - place * MINUTE, {
      threadId: ThreadId.make(thread),
      body: `Question ${count - place} of ${count}: who should this go to?`,
    }),
  )

const trialThread = (
  id: string,
  title: string,
  attention: NoticeThread['attention'],
): NoticeThread => ({ id: ThreadId.make(id), title, attention })

/** Every kind of failure in one list, spread over the first rows, where it is on screen. */
const worst = (now: number): NoticeTrial => ({
  threads: [
    trialThread(
      'unspaced',
      'Quarterly-revenue-reconciliation_and_forecast-variance_analysis-for-the-EMEA-and-APAC-regions_v12-FINAL(revised)[approved]',
      'NeedsYou',
    ),
    trialThread('rtl', 'نور الهدى عبد الرحمن: خطة الربع الثالث', 'Unread'),
    trialThread('emoji', '👩🏽‍💻 Priya’s launch checklist 🦊🚀', 'Working'),
    trialThread('letter', 'Q', 'Quiet'),
    trialThread('untitled', '   ', 'NeedsYou'),
    trialThread('markup', '<b>Budget</b> &amp; **plan**', 'Quiet'),
    trialThread('two', 'Đặng Thị Ngọc Hân’s onboarding', 'NeedsYou'),
    trialThread('nine', 'Benachrichtigungseinstellungen', 'NeedsYou'),
    trialThread('ninety', 'Weekly digest', 'Unread'),
    trialThread('thousand', 'Inbox triage', 'NeedsYou'),
  ],
  notices: [
    ...asked('unspaced', 3, now - 20_000),
    trialNotice('rtl', now - 12 * MINUTE, {
      kind: 'finished',
      title: 'Vivid finished',
      threadId: ThreadId.make('rtl'),
      body: 'https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved&'.padEnd(
        300,
        'x',
      ),
    }),
    trialNotice('emoji', now - 3 * HOUR, {
      kind: 'shared',
      title: 'Aleksandra Wiśniewska-Kowalczyk shared a Thread',
      threadId: ThreadId.make('emoji'),
      body: 'Line one\nLine two, after a newline',
      readAt: now - 2 * HOUR,
    }),
    trialNotice('invited', now - 5 * HOUR, {
      kind: 'invited',
      title: 'Christopher Alexander Montgomery III invited you to Northwind Industries Holdings',
      body: 'Join Northwind Industries Holdings as a member. invitation:trial-invitation',
    }),
    trialNotice('deleted', now - DAY, {
      kind: 'finished',
      title: 'Vivid finished',
      threadId: ThreadId.make('deleted'),
      body: 'The Thread this was about is gone.',
    }),
    // A finished Run is newer than the question it left, so the mark and the line are the Run's
    // while the Thread still waits.
    trialNotice('mixed-new', now - DAY - HOUR, {
      kind: 'finished',
      title: 'Vivid finished',
      threadId: ThreadId.make('two'),
      body: 'Drafted the welcome note.',
    }),
    trialNotice('mixed-old', now - DAY - 2 * HOUR, { threadId: ThreadId.make('two') }),
    trialNotice('letter', now - 2 * DAY, {
      threadId: ThreadId.make('letter'),
      body: '',
      readAt: now - DAY,
    }),
    trialNotice('untitled', now - 12 * DAY, { threadId: ThreadId.make('untitled') }),
    trialNotice('markup', now - 330 * DAY, {
      kind: 'finished',
      title: 'Vivid finished',
      threadId: ThreadId.make('markup'),
      body: '<script>alert(1)</script> &amp; **bold**',
      readAt: now - 329 * DAY,
    }),
    // A clock that runs ahead of the server's dates a notice in the future.
    trialNotice('future', now + 5 * MINUTE, { kind: 'shared', title: '', body: '' }),
    ...asked('nine', 9, now - 13 * DAY),
    ...asked('ninety', 99, now - 14 * DAY),
    ...asked('thousand', 1000, now - 15 * DAY),
  ],
})

/** Thirty Threads with one notice each, of every kind in turn, to fill and scroll the panel. */
const thirty = (now: number): NoticeTrial => {
  const kinds = ['needs-you', 'finished', 'shared', 'invited'] as const
  const places = Array.from({ length: 30 }, (_, place) => place)
  return {
    threads: places.map((place) => trialThread(`thread-${place}`, `Thread ${place + 1}`, 'Unread')),
    notices: places.map((place) =>
      trialNotice(`thirty-${place}`, now - place * 3 * HOUR, {
        kind: kinds[place % kinds.length],
        threadId: ThreadId.make(`thread-${place}`),
      }),
    ),
  }
}

/** A trial with every notice read, or every notice unread, at `at`. */
const withRead = (trial: NoticeTrial, readAt: number | null): NoticeTrial => ({
  threads: trial.threads,
  // Named field by field: a notice is a schema value, and spreading it would copy its data
  // without what the schema makes of it.
  notices: trial.notices.map((notice): Notification => ({
    id: notice.id,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    threadId: notice.threadId,
    createdAt: notice.createdAt,
    readAt,
  })),
})

/**
 * The trials, by the label the switch shows. Each is built from the moment the panel opened, so
 * "3h" in a trial is three hours before now and not before the day this was written.
 */
export const noticeTrials = {
  'Worst case': worst,
  '40 in one': (now) => ({
    threads: [trialThread('forty', 'Planning the offsite', 'NeedsYou')],
    notices: asked('forty', 40, now - HOUR),
  }),
  '30 Threads': thirty,
  'All read': (now) => withRead(worst(now), now),
  'All unread': (now) => withRead(worst(now), null),
  Empty: () => ({ threads: [], notices: [] }),
  One: (now) => ({
    threads: [trialThread('only', 'Getting to know you', 'NeedsYou')],
    notices: asked('only', 1, now - 15 * HOUR),
  }),
} as const satisfies Record<string, (now: number) => NoticeTrial>

export type NoticeTrialName = keyof typeof noticeTrials

/** The trial names in the order the switch lists them. */
export const noticeTrialNames: ReadonlyArray<NoticeTrialName> = [
  'Worst case',
  '40 in one',
  '30 Threads',
  'All read',
  'All unread',
  'Empty',
  'One',
]
