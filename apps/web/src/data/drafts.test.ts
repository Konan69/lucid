import { absorbed, draftIn, noDrafts, readDrafts, withDraft, writeDrafts } from '@vivid/state'
import { Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { open } from '../test/browser'

/**
 * The browser's draft store, driven the way a composer drives it (`draft.keep`, `draft.in`,
 * `draft.take`) and watched at the one thing it shares with the rest of the browser:
 * `localStorage`. The store is synchronous and holds every draft in one document, so each read
 * decodes all of them and each write encodes all of them, on the thread the Person is typing on.
 *
 * The module under test is the page's own, with the live engine behind it; only the browser is
 * the test's (`test/browser.ts`). Its server never says who is signed in, so nothing is owed to
 * it and these cases are about this browser alone. Time is the test's to move: the store is
 * written after a rest, and a rest is not waited out.
 */

const KEY = 'vivid-drafts'

vi.useFakeTimers()
const browser = open()
const { draft, forgetDrafts } = await import('./drafts')

/** The drafts the browser's store holds now. */
const stored = () => readDrafts(browser.store.read(KEY))

/**
 * The document another tab of this browser stores after a Person types in it: this tab's last
 * stored copy as that tab took it in (`absorbed`), and its own words on top.
 */
const fromOtherTab = (where: string, text: string) =>
  Option.getOrThrow(writeDrafts(withDraft(absorbed(noDrafts, stored()), where, text, 1)))

/** Types words one character at a time, as a keyboard does. */
const type = (where: string, words: string) => {
  for (let length = 1; length <= words.length; length += 1)
    draft.keep(where, words.slice(0, length))
}

describe('what a Person has typed and not sent, in this browser', () => {
  afterEach(() => {
    // Whatever is waiting to be written is written, so the next case starts with nothing owed.
    vi.advanceTimersByTime(1_000)
  })

  it('is on screen at each key without reading or writing the store, and is stored once at rest', () => {
    const words = 'Send the invoice to Dami'
    const before = { reads: browser.store.reads(KEY), writes: browser.store.writes(KEY) }

    type('ada:personal:typing', words)

    // The field draws from this at once; the store is not what it waits for.
    expect(draft.in('ada:personal:typing')).toBe(words)
    expect({
      reads: browser.store.reads(KEY) - before.reads,
      writes: browser.store.writes(KEY) - before.writes,
    }).toEqual({ reads: 0, writes: 0 })

    vi.advanceTimersByTime(1_000)

    expect(browser.store.writes(KEY) - before.writes).toBe(1)
    expect(draftIn(stored(), 'ada:personal:typing')).toBe(words)
  })

  it('is in the store when the page is left before the words have rested', () => {
    type('ada:personal:leaving', 'Half a sentence')

    browser.happens('pagehide')

    expect(draftIn(stored(), 'ada:personal:leaving')).toBe('Half a sentence')
  })

  it('takes in what another tab typed, and never over words being typed here', () => {
    browser.store.writtenElsewhere(
      KEY,
      fromOtherTab('ada:personal:elsewhere', 'Typed in the other tab'),
    )
    expect(draft.in('ada:personal:elsewhere')).toBe('Typed in the other tab')

    type('ada:personal:shared', 'Mine')
    browser.store.writtenElsewhere(KEY, fromOtherTab('ada:personal:shared', 'Theirs'))
    expect(draft.in('ada:personal:shared')).toBe('Mine')
  })

  it('does not write over a draft another tab stored while these words were resting', () => {
    // The other tab's write is in the store, and this tab has not been told of it yet.
    browser.store.writtenUnheard(
      KEY,
      fromOtherTab('ada:personal:theirs', 'Stored by the other tab'),
    )
    type('ada:personal:mine', 'Typed here')

    vi.advanceTimersByTime(1_000)

    expect(draftIn(stored(), 'ada:personal:mine')).toBe('Typed here')
    expect(draftIn(stored(), 'ada:personal:theirs')).toBe('Stored by the other tab')
  })

  it('gives its words to the first of three submissions in one turn, and none to the rest', () => {
    type('ada:personal:sending', 'latest messages popup is bad…')

    // Three presses of Enter handled before the field is drawn again: what a composer does.
    const taken = [1, 2, 3].map(() => draft.take('ada:personal:sending'))

    expect(taken).toEqual(['latest messages popup is bad…', '', ''])
    expect(draft.in('ada:personal:sending')).toBe('')
  })

  it('leaves words that are only space where they are when asked for words to send', () => {
    draft.keep('ada:personal:space', '  \n')

    expect(draft.take('ada:personal:space')).toBe('')
    expect(draft.in('ada:personal:space')).toBe('  \n')
  })

  it('shows words that are only space without keeping them', () => {
    draft.keep('ada:personal:blank', '\n')

    expect(draft.in('ada:personal:blank')).toBe('\n')
    vi.advanceTimersByTime(1_000)
    expect(draftIn(stored(), 'ada:personal:blank')).toBe('')
  })

  it('forgets at once when the session ends, and writes nothing after', () => {
    type('ada:personal:ending', 'Never saved')

    forgetDrafts()
    const written = browser.store.writes(KEY)
    // Words the server never took are nowhere else, so they stay, in the store already.
    expect(draftIn(stored(), 'ada:personal:ending')).toBe('Never saved')
    expect(stored().marks).toEqual(noDrafts.marks)

    vi.advanceTimersByTime(1_000)
    expect(browser.store.writes(KEY)).toBe(written)
  })
})
