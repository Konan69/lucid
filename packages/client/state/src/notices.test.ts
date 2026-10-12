import { NotificationId, ThreadId, type Notification } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  everyNoticeRead,
  invitationIn,
  noticeFace,
  noticeRows,
  noticesRead,
  NoticeRow,
  type NoticeThread,
} from './notices.js'

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
 * A long mixed list, as the panel has it after two weeks away: Threads that asked three, nine,
 * ninety-nine and a thousand times, rows already read, a Thread that was deleted, an invitation,
 * a finished Run newer than the question it left, and a notice a fast server clock dated ahead of
 * this one. It came from the `break-ui` review of 4 October 2026. What is claimed is the rows and
 * their counts; how long titles and other scripts are drawn is the screens' to show.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `count` unread questions in one Thread, a minute apart, the newest at `at`. */
const asked = (about: string, count: number, at: number): ReadonlyArray<Notification> =>
  Array.from({ length: count }, (_, place) =>
    notice(`${about}-${place}`, at - place * MINUTE, { threadId: ThreadId.make(about) }),
  )

describe('noticeRows over a long mixed list', () => {
  it('makes one row for each Thread and each notice about none, newest first, with its unread count', () => {
    const about = (id: string, at: number, changes: Partial<Notification>) =>
      notice(id, at, { threadId: ThreadId.make(id), ...changes })
    const notices = [
      ...asked('three', 3, NOW - 20_000),
      about('once', NOW - 12 * MINUTE, { kind: 'finished' }),
      about('read', NOW - 3 * HOUR, { kind: 'shared', readAt: NOW - 2 * HOUR }),
      notice('invited', NOW - 5 * HOUR, { kind: 'invited', threadId: null }),
      about('deleted', NOW - DAY, { kind: 'finished' }),
      notice('mixed-new', NOW - DAY - HOUR, { kind: 'finished', threadId: ThreadId.make('two') }),
      notice('mixed-old', NOW - DAY - 2 * HOUR, { threadId: ThreadId.make('two') }),
      about('old-read', NOW - 330 * DAY, { readAt: NOW - 329 * DAY }),
      notice('future', NOW + 5 * MINUTE, { kind: 'shared', threadId: null }),
      ...asked('nine', 9, NOW - 13 * DAY),
      ...asked('ninety', 99, NOW - 14 * DAY),
      ...asked('thousand', 1000, NOW - 15 * DAY),
    ]
    // Every Thread but the deleted one is still in the Person's list.
    const threads = ['three', 'once', 'read', 'two', 'old-read', 'nine', 'ninety', 'thousand'].map(
      (id) => thread(id, `Thread ${id}`, 'Unread'),
    )
    expect(
      noticeRows(notices, threads).map(
        NoticeRow.$match({
          Single: ({ notice: single }) => [single.id, 'alone'],
          Grouped: ({ threadId, unread }) => [threadId, unread.length],
        }),
      ),
    ).toEqual([
      ['future', 'alone'],
      ['three', 3],
      ['once', 1],
      ['read', 0],
      ['invited', 'alone'],
      ['deleted', 1],
      ['two', 2],
      ['nine', 9],
      ['ninety', 99],
      ['thousand', 1000],
      ['old-read', 0],
    ])
  })
})

describe('noticeFace', () => {
  it('leads a Thread’s row with the Thread’s title and says what the notice is', () => {
    const [row] = noticeRows(
      [notice('a', NOW, { title: 'Vivid has a question', body: 'Which quarter?' })],
      [thread('first', 'Board pack', 'NeedsYou')],
    )
    expect(Option.map(Option.fromUndefinedOr(row), noticeFace)).toEqual(
      Option.some({
        key: 'first',
        heading: 'Board pack',
        notice: notice('a', NOW, { title: 'Vivid has a question', body: 'Which quarter?' }),
        line: 'Which quarter?',
        spoken: Option.some('Vivid has a question'),
        waiting: true,
        unread: 1,
      }),
    )
  })

  it('leads with the notice itself when its Thread was deleted', () => {
    const [row] = noticeRows([notice('a', NOW, { title: 'Vivid finished' })], [])
    const face = Option.map(Option.fromUndefinedOr(row), noticeFace)
    expect(Option.map(face, (shown) => shown.heading)).toEqual(Option.some('Vivid finished'))
    expect(Option.map(face, (shown) => shown.waiting)).toEqual(Option.some(false))
  })

  it('calls a notice with no title by its kind', () => {
    const [row] = noticeRows(
      [notice('a', NOW, { title: '  ', threadId: null, kind: 'shared' })],
      [],
    )
    expect(Option.map(Option.fromUndefinedOr(row), (shown) => noticeFace(shown).heading)).toEqual(
      Option.some('A Thread was shared with you'),
    )
  })

  it('reads an invitation out of its notice and leaves the sentence', () => {
    const invited = notice('a', NOW, {
      kind: 'invited',
      threadId: null,
      body: 'Dami invited you to Northwind invitation:inv_42',
    })
    expect(invitationIn(invited)).toEqual(Option.some('inv_42'))
    expect(noticeFace(NoticeRow.Single({ notice: invited })).line).toBe(
      'Dami invited you to Northwind',
    )
    expect(invitationIn(notice('b', NOW, {}))).toEqual(Option.none())
  })
})
