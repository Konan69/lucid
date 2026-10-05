import { NotificationId, ThreadId, type Notification } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { everyNoticeRead, noticeRows, noticesRead, NoticeRow, type NoticeThread } from './notices'

const NOW = Date.UTC(2026, 9, 4, 12)

/** An unread question in Thread `first`, changed per test. */
const notice = (id: string, at: number, changes: Partial<Notification>): Notification => ({
  id: NotificationId.make(id),
  kind: 'needs-you',
  title: 'Vivid has a question',
  body: `Body of ${id}`,
  threadId: ThreadId.make('first'),
  createdAt: at,
  readAt: null,
  ...changes,
})

const thread = (id: string, title: string, attention: NoticeThread['attention']): NoticeThread => ({
  id: ThreadId.make(id),
  title,
  attention,
})

/** The one Grouped row a test expects, or a failure that says what was there instead. */
const groupedIn = (rows: ReadonlyArray<NoticeRow>, place: number) => {
  const row = rows[place]
  if (row === undefined || !NoticeRow.$is('Grouped')(row)) {
    throw new Error(`Expected a Grouped row at ${place}, found ${JSON.stringify(row)}`)
  }
  return row
}

describe('noticeRows', () => {
  it('has no rows for no notices', () => {
    expect(noticeRows([], [thread('first', 'Getting to know you', 'Quiet')])).toEqual([])
  })

  it('makes one notice about a Thread one row, led by the Thread’s title', () => {
    const only = notice('a', NOW, {})
    const rows = noticeRows([only], [thread('first', 'Getting to know you', 'NeedsYou')])
    expect(rows).toEqual([
      NoticeRow.Grouped({
        threadId: ThreadId.make('first'),
        title: Option.some('Getting to know you'),
        newest: only,
        waiting: true,
        unread: [only.id],
      }),
    ])
  })

  it('puts every notice about the same Thread in one row', () => {
    const rows = noticeRows(
      [notice('c', NOW, {}), notice('b', NOW - 1, {}), notice('a', NOW - 2, {})],
      [thread('first', 'Getting to know you', 'NeedsYou')],
    )
    expect(rows).toHaveLength(1)
    const row = groupedIn(rows, 0)
    expect(row.newest.id).toBe('c')
    expect(row.unread).toEqual(['c', 'b', 'a'])
  })

  it('takes the mark and the line from the newest notice when kinds are mixed', () => {
    const rows = noticeRows(
      [
        notice('question', NOW - 10, {}),
        notice('done', NOW, { kind: 'finished', body: 'Drafted the note.' }),
      ],
      [thread('first', 'Onboarding', 'NeedsYou')],
    )
    const row = groupedIn(rows, 0)
    expect(row.newest.kind).toBe('finished')
    expect(row.newest.body).toBe('Drafted the note.')
    // The Thread still waits on its question, though the newest notice is not the question.
    expect(row.waiting).toBe(true)
  })

  it('does not say a Thread waits once its question was answered', () => {
    const rows = noticeRows([notice('a', NOW, {})], [thread('first', 'Onboarding', 'Quiet')])
    expect(groupedIn(rows, 0).waiting).toBe(false)
  })

  it('keeps a notice about no Thread as a row of its own', () => {
    const first = notice('a', NOW, { kind: 'invited', threadId: null })
    const second = notice('b', NOW - 1, { kind: 'invited', threadId: null })
    expect(noticeRows([first, second], [])).toEqual([
      NoticeRow.Single({ notice: first }),
      NoticeRow.Single({ notice: second }),
    ])
  })

  it('orders rows by their newest notice, whatever order they arrived in', () => {
    const rows = noticeRows(
      [
        notice('old', NOW - 300, { threadId: ThreadId.make('second') }),
        notice('invite', NOW - 200, { kind: 'invited', threadId: null }),
        notice('older', NOW - 400, {}),
        notice('new', NOW - 100, {}),
      ],
      [],
    )
    expect(
      rows.map(
        NoticeRow.$match({
          Single: ({ notice: single }) => single.id,
          Grouped: ({ threadId }) => threadId,
        }),
      ),
    ).toEqual(['first', 'invite', 'second'])
  })

  it('leaves a read row above an older unread one', () => {
    const rows = noticeRows(
      [
        notice('unread', NOW - 100, { threadId: ThreadId.make('second') }),
        notice('read', NOW, { readAt: NOW }),
      ],
      [],
    )
    expect(rows.map((row) => groupedIn([row], 0).threadId)).toEqual(['first', 'second'])
  })

  it('counts only the unread notices of a group', () => {
    const rows = noticeRows(
      [notice('a', NOW, { readAt: NOW }), notice('b', NOW - 1, {}), notice('c', NOW - 2, {})],
      [],
    )
    expect(groupedIn(rows, 0).unread).toEqual(['b', 'c'])
    const allRead = noticeRows([notice('a', NOW, { readAt: NOW })], [])
    expect(groupedIn(allRead, 0).unread).toEqual([])
  })

  it('has no Thread title for a Thread that is not in the list, or not titled yet', () => {
    const missing = groupedIn(noticeRows([notice('a', NOW, {})], []), 0)
    expect(missing.title).toEqual(Option.none())
    expect(missing.waiting).toBe(false)
    const untitled = noticeRows([notice('a', NOW, {})], [thread('first', '   ', 'NeedsYou')])
    expect(groupedIn(untitled, 0).title).toEqual(Option.none())
  })

  it('keeps the first of two notices written in the same millisecond as the newest', () => {
    const rows = noticeRows([notice('a', NOW, {}), notice('b', NOW, {})], [])
    expect(groupedIn(rows, 0).newest.id).toBe('a')
  })
})

describe('noticesRead', () => {
  it('reads the named unread notices and lowers the count by what changed', () => {
    const list = {
      notifications: [
        notice('a', NOW, {}),
        notice('b', NOW - 1, { readAt: NOW - 1 }),
        notice('c', NOW - 2, {}),
      ],
      // More than this window holds: the server counts everything unread.
      unreadCount: 7,
    }
    const next = noticesRead([NotificationId.make('a'), NotificationId.make('b')], NOW + 5)(list)
    expect(next.notifications.map((each) => each.readAt)).toEqual([NOW + 5, NOW - 1, null])
    expect(next.unreadCount).toBe(6)
  })
})

describe('everyNoticeRead', () => {
  it('leaves nothing unread and keeps when each was already read', () => {
    const list = {
      notifications: [notice('a', NOW, {}), notice('b', NOW - 1, { readAt: NOW - 1 })],
      unreadCount: 9,
    }
    const next = everyNoticeRead(NOW + 5)(list)
    expect(next.notifications.map((each) => each.readAt)).toEqual([NOW + 5, NOW - 1])
    expect(next.unreadCount).toBe(0)
  })
})

/*
 * Worst-case lists for the panel (the `break-ui` review of 4 October 2026): one Thread that asked
 * forty times, thirty Threads at once, a title with no space to break at, a body that is one
 * unbroken string, right-to-left and emoji titles, a Thread that was deleted, and counts from one
 * to a thousand. They were once offered in the panel behind a development switch; a tester in the
 * product is not a test, so they live here and are drawn through `noticeRows` below.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What a trial hands the panel in place of the live queries. */
interface NoticeTrial {
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
const asked = (about: string, count: number, at: number): ReadonlyArray<Notification> =>
  Array.from({ length: count }, (_, place) =>
    trialNotice(`${about}-${place}`, at - place * MINUTE, {
      threadId: ThreadId.make(about),
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
  notices: trial.notices.map((each): Notification => ({
    id: each.id,
    kind: each.kind,
    title: each.title,
    body: each.body,
    threadId: each.threadId,
    createdAt: each.createdAt,
    readAt,
  })),
})

/**
 * The trials, by the label the switch shows. Each is built from the moment the panel opened, so
 * "3h" in a trial is three hours before now and not before the day this was written.
 */
const noticeTrials = {
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

type NoticeTrialName = keyof typeof noticeTrials

/** The trial names in the order the switch lists them. */
const noticeTrialNames: ReadonlyArray<NoticeTrialName> = [
  'Worst case',
  '40 in one',
  '30 Threads',
  'All read',
  'All unread',
  'Empty',
  'One',
]

describe('noticeTrials', () => {
  it('lists every trial once', () => {
    expect(new Set(noticeTrialNames)).toEqual(new Set(Object.keys(noticeTrials)))
    expect(noticeTrialNames).toHaveLength(Object.keys(noticeTrials).length)
  })

  it('gives every notice of a trial its own id, so no row is drawn twice', () => {
    for (const name of noticeTrialNames) {
      const ids = noticeTrials[name](NOW).notices.map((each) => each.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('groups the worst case into a row for each Thread, with counts of 1, 2, 9, 99 and 1000', () => {
    const trial = noticeTrials['Worst case'](NOW)
    const rows = noticeRows(trial.notices, trial.threads)
    const counts = rows.map(
      NoticeRow.$match({ Single: () => 1, Grouped: ({ unread }) => unread.length }),
    )
    expect(rows).toHaveLength(13)
    expect(counts).toEqual(expect.arrayContaining([0, 1, 2, 3, 9, 99, 1000]))
  })

  it('makes forty notices from one Thread one row', () => {
    const trial = noticeTrials['40 in one'](NOW)
    const rows = noticeRows(trial.notices, trial.threads)
    expect(rows).toHaveLength(1)
    expect(groupedIn(rows, 0).unread).toHaveLength(40)
  })
})
