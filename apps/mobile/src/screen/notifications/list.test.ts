import { InvitationId, NotificationId, ThreadId, type Notification } from '@vivid/contracts'
import { noticeRows, type NoticeThread } from '@vivid/state'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { answers, Destination } from './destination'
import { Item, itemKey, itemsOf } from './list'

// Noon, local time, so "an hour ago" is the same day wherever the suite runs.
const NOW = new Date(2026, 9, 4, 12).getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** An unread "finished" notice about Thread `first`, changed per test. */
const notice = (id: string, at: number, changes: Partial<Notification>): Notification => ({
  id: NotificationId.make(id),
  kind: 'finished',
  title: 'Vivid finished',
  body: `Body of ${id}`,
  threadId: ThreadId.make('first'),
  createdAt: at,
  readAt: null,
  ...changes,
})

const thread = (id: string, title: string): NoticeThread => ({
  id: ThreadId.make(id),
  title,
  attention: 'Quiet',
})

/** The screen's items for these notices, with the Thread list answered (or not yet). */
const listed = (
  notices: ReadonlyArray<Notification>,
  threads: Option.Option<ReadonlyArray<NoticeThread>>,
) =>
  itemsOf(
    noticeRows(
      notices,
      Option.getOrElse(threads, () => []),
    ),
    Option.map(threads, (known) => new Set(known.map((each) => each.id))),
    NOW,
  )

/** What each item is, in order: a band's name, or the key of a row and where it leads. */
const outline = (items: ReadonlyArray<Item>) =>
  items.map(
    Item.$match({
      Heading: ({ label }) => label,
      Entry: ({ face, leads }) => `${face.key} -> ${leads._tag}`,
    }),
  )

describe('itemsOf', () => {
  it('heads each day band once, in order, and leaves out a band that holds nothing', () => {
    const items = listed(
      [
        notice('a', NOW - HOUR, { threadId: ThreadId.make('one') }),
        notice('b', NOW - 2 * HOUR, { threadId: ThreadId.make('two') }),
        notice('c', NOW - 30 * DAY, { threadId: ThreadId.make('three') }),
      ],
      Option.some([thread('one', 'One'), thread('two', 'Two'), thread('three', 'Three')]),
    )
    expect(outline(items)).toEqual([
      'Today',
      'one -> Thread',
      'two -> Thread',
      'Earlier',
      'three -> Thread',
    ])
    expect(new Set(items.map(itemKey)).size).toBe(items.length)
  })

  it('files a notice dated ahead of the phone’s clock under Today', () => {
    const items = listed([notice('ahead', NOW + 5 * 60_000, { threadId: null })], Option.some([]))
    expect(outline(items)).toEqual(['Today', 'ahead -> Nowhere'])
  })

  it('reads every unread notice of a Thread with one press, and none of the read ones', () => {
    const items = listed(
      [notice('new', NOW, {}), notice('old', NOW - HOUR, { readAt: NOW - 60_000 })],
      Option.some([thread('first', 'Onboarding')]),
    )
    const entry = items.find(Item.$is('Entry'))
    expect(entry === undefined ? [] : entry.unread).toEqual(['new'])
  })
})

describe('where a row leads', () => {
  it('opens a Thread that is in the Person’s list', () => {
    const items = listed([notice('a', NOW, {})], Option.some([thread('first', 'Onboarding')]))
    expect(outline(items)).toEqual(['Today', 'first -> Thread'])
  })

  it('says a Thread is gone once the list has answered without it', () => {
    const items = listed([notice('a', NOW, {})], Option.some([thread('other', 'Other')]))
    expect(outline(items)).toEqual(['Today', 'first -> Gone'])
  })

  it('does not call a Thread gone while the Thread list is still on its way', () => {
    const items = listed([notice('a', NOW, {})], Option.none())
    expect(outline(items)).toEqual(['Today', 'first -> Thread'])
  })

  it('sends an invitation to its page, and a notice about nothing nowhere', () => {
    const items = listed(
      [
        notice('invite', NOW, {
          kind: 'invited',
          threadId: null,
          body: 'Join Northwind as a member. invitation:inv-1',
        }),
        notice('bare', NOW - HOUR, { kind: 'shared', threadId: null }),
      ],
      Option.some([]),
    )
    expect(outline(items)).toEqual(['Today', 'invite -> Invitation', 'bare -> Nowhere'])
    const first = items.find(Item.$is('Entry'))
    expect(first === undefined ? undefined : first.leads).toEqual(
      Destination.Invitation({ id: InvitationId.make('inv-1') }),
    )
  })
})

describe('answers', () => {
  it('always answers a press that goes somewhere', () => {
    expect(answers(Destination.Thread({ id: ThreadId.make('first') }), 0)).toBe(true)
  })

  it('answers a press on a row that leads nowhere only while it is unread', () => {
    expect(answers(Destination.Gone(), 2)).toBe(true)
    expect(answers(Destination.Gone(), 0)).toBe(false)
    expect(answers(Destination.Nowhere(), 1)).toBe(true)
    expect(answers(Destination.Nowhere(), 0)).toBe(false)
  })
})
