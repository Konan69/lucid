import { NotificationId, ThreadId, type Notification } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  everyNoticeRead,
  noticeRows,
  noticesRead,
  noticeTrialNames,
  noticeTrials,
  NoticeRow,
  type NoticeThread,
} from './notices'

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
