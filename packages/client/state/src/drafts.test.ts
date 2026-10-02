import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { draftIn, draftPlace, noDrafts, readDrafts, withDraft, writeDrafts } from './drafts.js'

const ada = (thread: string) =>
  draftPlace('ada', { workspace: 'northwind', thread: Option.some(thread) })

describe('drafts', () => {
  it('keeps what was typed in each place apart, and per Person', () => {
    const typed = withDraft(
      withDraft(noDrafts, ada('t1'), 'Ask Dami for', 1),
      ada('t2'),
      'Draft',
      2,
    )
    expect(draftIn(typed, ada('t1'))).toBe('Ask Dami for')
    expect(draftIn(typed, ada('t2'))).toBe('Draft')
    expect(
      draftIn(typed, draftPlace('ben', { workspace: 'northwind', thread: Option.some('t1') })),
    ).toBe('')
    expect(
      draftIn(typed, draftPlace('ada', { workspace: 'northwind', thread: Option.none() })),
    ).toBe('')
  })

  it('keeps a new Thread half-written in one workspace out of the next one', () => {
    const northwind = draftPlace('ada', { workspace: 'northwind', thread: Option.none() })
    const personal = draftPlace('ada', { workspace: 'personal', thread: Option.none() })
    const typed = withDraft(noDrafts, northwind, 'Confidential: Q3 numbers for', 1)
    expect(draftIn(typed, northwind)).toBe('Confidential: Q3 numbers for')
    expect(draftIn(typed, personal)).toBe('')
  })

  it('has no draft once the words are sent or cleared', () => {
    const typed = withDraft(noDrafts, ada('t1'), 'Ask Dami for', 1)
    expect(withDraft(typed, ada('t1'), '  ', 2)).toEqual(noDrafts)
  })

  it('lets the oldest go when a device holds more than it keeps', () => {
    const many = Array.from({ length: 60 }, (_, index) => index).reduce(
      (drafts, index) => withDraft(drafts, ada(`t${index}`), `words ${index}`, index),
      noDrafts,
    )
    expect(many.entries).toHaveLength(50)
    expect(draftIn(many, ada('t59'))).toBe('words 59')
    expect(draftIn(many, ada('t0'))).toBe('')
  })

  it('survives being stored, and reads anything else as no drafts', () => {
    const typed = withDraft(noDrafts, ada('t1'), 'Ask Dami for the signed NDA', 1)
    expect(readDrafts(Option.some(writeDrafts(typed)))).toEqual(typed)
    expect(readDrafts(Option.none())).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":1,"entries":[{"where":'))).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":2,"entries":[]}'))).toEqual(noDrafts)
  })
})
