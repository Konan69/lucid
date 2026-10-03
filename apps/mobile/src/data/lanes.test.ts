import { PersonId, ThreadAudience, ThreadId, type Thread } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { arrange, bandOf, matching, Row, rowKey, rowsOf } from './lanes.ts'

/** Wednesday 14 October 2026, mid-afternoon, on whatever clock the test machine keeps. */
const now = new Date(2026, 9, 14, 15, 0).getTime()

/** A moment `days` calendar days before `now`, at a given hour of that day. */
const daysAgo = (days: number, hour: number) => new Date(2026, 9, 14 - days, hour, 0).getTime()

const thread = (
  id: string,
  changes: Partial<Pick<Thread, 'attention' | 'updatedAt' | 'archived' | 'title' | 'preview'>>,
): Thread => ({
  id: ThreadId.make(id),
  title: id,
  preview: '',
  updatedAt: now,
  archived: false,
  createdBy: { id: PersonId.make('ada'), name: 'Ada Obi', image: null },
  audience: ThreadAudience.cases.Private.make({}),
  projectId: null,
  attention: 'Quiet',
  ...changes,
})

const labels = (threads: ReadonlyArray<Thread>) =>
  arrange(threads, now).lanes.map((lane) => [
    lane.label,
    lane.threads.map((each) => String(each.id)),
  ])

describe('which day a Thread last moved', () => {
  it('goes by the calendar, not by how many hours ago it was', () => {
    // One minute past midnight today is today; one minute before it was yesterday, though both
    // are less than a day ago.
    expect(bandOf(new Date(2026, 9, 14, 0, 1).getTime(), now)).toBe('Today')
    expect(bandOf(new Date(2026, 9, 13, 23, 59).getTime(), now)).toBe('Yesterday')
  })

  it('counts a week as six days back, then everything before it', () => {
    expect(bandOf(daysAgo(2, 9), now)).toBe('This week')
    expect(bandOf(daysAgo(6, 9), now)).toBe('This week')
    expect(bandOf(daysAgo(7, 9), now)).toBe('Earlier')
  })
})

describe('arranging Threads', () => {
  it('puts what needs the Person first, then what Vivid is working on, then by day', () => {
    expect(
      labels([
        thread('old', { updatedAt: daysAgo(30, 9) }),
        thread('working', { attention: 'Working', updatedAt: daysAgo(3, 9) }),
        thread('today', {}),
        thread('needs', { attention: 'NeedsYou', updatedAt: daysAgo(30, 9) }),
        thread('yesterday', { updatedAt: daysAgo(1, 9) }),
      ]),
    ).toEqual([
      ['Needs you', ['needs']],
      ['Working', ['working']],
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Earlier', ['old']],
    ])
  })

  it('keeps an unread Thread in its day and the server’s order within a lane', () => {
    expect(
      labels([thread('b', { attention: 'Unread' }), thread('a', {}), thread('c', {})]),
    ).toEqual([['Today', ['b', 'a', 'c']]])
  })

  it('keeps archived Threads out of every lane, whatever they need', () => {
    const arrangement = arrange(
      [thread('gone', { archived: true, attention: 'NeedsYou' }), thread('here', {})],
      now,
    )
    expect(arrangement.lanes.map((lane) => lane.label)).toEqual(['Today'])
    expect(arrangement.archived.map((each) => each.id)).toEqual(['gone'])
  })

  it('has no lanes when there are no Threads', () => {
    expect(arrange([], now)).toEqual({ lanes: [], archived: [] })
  })
})

describe('the list as rows', () => {
  it('counts the attention lanes and not the days', () => {
    const needs = thread('needs', { attention: 'NeedsYou' })
    const quiet = thread('quiet', {})
    const rows = rowsOf(arrange([needs, quiet], now).lanes)
    expect(rows).toEqual([
      Row.Heading({ label: 'Needs you', count: Option.some(1) }),
      Row.Entry({ thread: needs, variant: 'card' }),
      Row.Heading({ label: 'Today', count: Option.none() }),
      Row.Entry({ thread: quiet, variant: 'line' }),
    ])
    expect(rows.map(rowKey)).toEqual(['lane:Needs you', 'needs', 'lane:Today', 'quiet'])
  })
})

describe('finding a Thread by what was typed', () => {
  const threads = [
    thread('one', { title: 'Office move', preview: 'The movers confirmed Friday' }),
    thread('two', { title: 'Hiring', preview: 'Two candidates left' }),
  ]

  it('looks in the title and the last words, whatever the case', () => {
    expect(matching(threads, 'MOVERS').map((each) => each.id)).toEqual(['one'])
    expect(matching(threads, ' hiring ').map((each) => each.id)).toEqual(['two'])
  })

  it('shows everything while nothing is typed', () => {
    expect(matching(threads, '  ')).toBe(threads)
  })
})
