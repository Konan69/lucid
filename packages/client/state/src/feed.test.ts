import { FeedCardId, FeedItem, ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { Press, Settling, feedFace, feedView, fill, folds, pressKey, standingOf } from './feed.js'

const thread = ThreadId.make('00000000-0000-4000-8000-000000000001')
const waiting = FeedItem.cases.Waiting.make({
  card: FeedCardId.make('card-1'),
  thread,
  from: 'Trip to Abuja',
  at: 10,
  post: {
    title: 'Which flight?',
    words: 'Both land in time.',
    display: null,
    actions: ['Not now', 'Book $flight'],
  },
  seen: false,
  asking: [],
})
const working = FeedItem.cases.Working.make({
  card: FeedCardId.make('card-2'),
  thread,
  from: 'Investor update',
  since: 5,
  post: null,
})

describe("a card button's words", () => {
  it('say what the Person picked under the name they use', () => {
    expect(fill('Book $flight', { $flight: 'Arik Air at 7:10' })).toBe('Book Arik Air at 7:10')
  })

  it('read a pick the renderer keeps inside its field', () => {
    expect(fill('Keep $day clear', { $day: { value: 'Fri 16', componentType: 'Select' } })).toBe(
      'Keep Fri 16 clear',
    )
  })

  it('say numbers, ticks and several picks as words', () => {
    expect(
      fill('Send $count to $who, cc $cc', { $count: 3, $who: ['Ada', 'Tobi'], $cc: false }),
    ).toBe('Send 3 to Ada, Tobi, cc no')
  })

  it('leave a name nothing was chosen under as Vivid wrote it', () => {
    expect(fill('Book $flight', {})).toBe('Book $flight')
    expect(fill('Book $flight', { $flight: '  ' })).toBe('Book $flight')
  })
})

describe('the Feed as it is drawn', () => {
  it('sorts items by stage and counts what waits', () => {
    const view = feedView([working, waiting])
    expect(view.waiting.map((item) => item.from)).toEqual(['Trip to Abuja'])
    expect(view.working.map((item) => item.from)).toEqual(['Investor update'])
    expect(standingOf(view.waiting.length)).toEqual({
      lead: '1 thing needs you.',
      rest: 'The rest is handled.',
    })
    expect(standingOf(0)).toEqual({ lead: 'Nothing needs you.', rest: '' })
  })

  it('shows the face pleased after a settle, then at work, then asking', () => {
    const view = feedView([working, waiting])
    expect(feedFace(view, true)).toBe('done')
    expect(feedFace(view, false)).toBe('working')
    expect(feedFace(feedView([waiting]), false)).toBe('waiting')
    expect(feedFace(feedView([]), false)).toBe('idle')
  })
})

describe('a press on a card', () => {
  const said = (key: string) => ({ at: 10, how: Settling.Said({ words: 'Book Arik', key }) })

  it('folds the card it answered until Vivid posts again', () => {
    expect(folds(waiting, Option.some(Press.Sending(said('a'))))).toBe(true)
    expect(folds(waiting, Option.some(Press.Unsent(said('a'))))).toBe(false)
    expect(folds({ ...waiting, at: 11 }, Option.some(Press.Sent(said('a'))))).toBe(false)
  })

  it('keeps the failed delivery key for the same words, and a new one otherwise', () => {
    const lost = Option.some(Press.Unsent(said('kept')))
    expect(pressKey(waiting, lost, 'Book Arik', () => 'new')).toBe('kept')
    expect(pressKey(waiting, lost, 'Not now', () => 'new')).toBe('new')
    expect(pressKey(waiting, Option.none(), 'Book Arik', () => 'new')).toBe('new')
  })
})
