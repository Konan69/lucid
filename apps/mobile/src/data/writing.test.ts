import { CompanyId, DraftWorkspace, ThreadId } from '@vivid/contracts'
import { draftIn, draftPlace, noDrafts, owed, withDraft, type Drafts } from '@vivid/state'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { answered, draftsOf, keeping, unread, wordsIn, type Writing } from './writing.ts'

const ada = (thread: string) =>
  draftPlace('ada', { workspace: 'northwind', thread: Option.some(ThreadId.make(thread)) })

/** Types into `count` places, one after another, starting from `from`. */
const typedIn = (from: Writing, count: number): Writing =>
  Array.from({ length: count }, (_, index) => index).reduce(
    (writing, index) => keeping(writing, ada(`t${index}`), `words ${index}`, index),
    from,
  )

/** The drafts the store would be given; a test that asks before the store answered has failed. */
const kept = (writing: Writing): Drafts => Option.getOrThrow(draftsOf(writing))

describe('typing before the phone has read its store', () => {
  it('shows what was typed and gives the store nothing to write yet', () => {
    const typing = keeping(unread, ada('t1'), 'Ask Dami for', 1)
    expect(wordsIn(typing, ada('t1'))).toBe('Ask Dami for')
    expect(wordsIn(typing, ada('t2'))).toBe('')
    // Writing this run's words alone would replace everything the device had kept.
    expect(Option.isNone(draftsOf(typing))).toBe(true)
  })

  it('lays what was typed over what the store held, newest first', () => {
    const stored = withDraft(withDraft(noDrafts, ada('t1'), 'old words', 1), ada('t2'), 'kept', 2)
    const typing = keeping(keeping(unread, ada('t3'), 'new place', 3), ada('t1'), 'new words', 4)
    const read = answered(typing, stored, 5)
    expect(wordsIn(read, ada('t1'))).toBe('new words')
    expect(wordsIn(read, ada('t2'))).toBe('kept')
    expect(kept(read).entries.map((draft) => draft.where)).toEqual([
      ada('t1'),
      ada('t3'),
      ada('t2'),
    ])
  })

  it('does not bring back words that were sent before the store answered', () => {
    const stored = withDraft(noDrafts, ada('t1'), 'Ask Dami for the signed NDA', 1)
    // Sending empties the composer; the store still holds the words it was sent with.
    const read = answered(keeping(unread, ada('t1'), '', 2), stored, 3)
    expect(wordsIn(read, ada('t1'))).toBe('')
    expect(draftIn(kept(read), ada('t1'))).toBe('')
    // The emptying is what the Person's other devices still have to hear about.
    expect(
      owed(kept(read), {
        person: 'ada',
        workspace: DraftWorkspace.cases.Company.make({ company: CompanyId.make('northwind') }),
      }).map((place) => place.text),
    ).toEqual([''])
  })

  it('writes nothing new when nothing was typed', () => {
    const stored = withDraft(noDrafts, ada('t1'), 'Ask Dami for', 1)
    expect(kept(answered(unread, stored, 2))).toBe(stored)
  })
})

describe('typing once the store has been read', () => {
  const read = answered(unread, noDrafts, 0)

  it('holds no more than the device keeps, however many places are typed in', () => {
    const many = typedIn(read, 60)
    // The same set `withDraft` alone would have kept: the bound is the shared model's, not a
    // second number that could drift from it.
    const model = Array.from({ length: 60 }, (_, index) => index).reduce(
      (drafts, index) => withDraft(drafts, ada(`t${index}`), `words ${index}`, index),
      noDrafts,
    )
    expect(kept(many)).toEqual(model)
    expect(wordsIn(many, ada('t59'))).toBe('words 59')
    expect(wordsIn(many, ada('t0'))).toBe('')
  })

  it('holds no more than the device keeps for places that were emptied', () => {
    const emptied = Array.from({ length: 200 }, (_, index) => index).reduce(
      (writing, index) =>
        keeping(keeping(writing, ada(`t${index}`), 'hello', index), ada(`t${index}`), '', index),
      read,
    )
    // An emptied place is remembered only until the server has been told, and never beyond what
    // a device keeps: no words are left, and the set does not grow with every place visited.
    expect(kept(emptied).entries).toHaveLength(50)
    expect(kept(emptied).entries.every((entry) => entry.text === '')).toBe(true)
  })

  it('shows a leading new line in its field without keeping it as a draft', () => {
    const started = keeping(read, ada('t1'), '\n', 1)
    expect(wordsIn(started, ada('t1'))).toBe('\n')
    expect(kept(started)).toEqual(noDrafts)
    // Once there are words after it, they are a draft, new line and all.
    const written = keeping(started, ada('t1'), '\nDear Dami', 2)
    expect(draftIn(kept(written), ada('t1'))).toBe('\nDear Dami')
  })

  it('keeps a new line typed just before the store answered in its field', () => {
    const stored = withDraft(noDrafts, ada('t1'), 'old words', 1)
    const answeredMidline = answered(keeping(unread, ada('t1'), '\n', 2), stored, 3)
    expect(wordsIn(answeredMidline, ada('t1'))).toBe('\n')
    expect(draftIn(kept(answeredMidline), ada('t1'))).toBe('')
  })

  it('is not changed by a store that answers a second time', () => {
    const typing = keeping(read, ada('t1'), 'Ask Dami for', 1)
    const stale = withDraft(noDrafts, ada('t1'), 'older words', 0)
    expect(answered(typing, stale, 2)).toBe(typing)
  })
})
