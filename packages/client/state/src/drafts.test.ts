import { DraftPlace, DraftSaved, ThreadId, type Draft } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  abandoned,
  draftIn,
  draftPlace,
  heard,
  noDrafts,
  owed,
  placeOf,
  readDrafts,
  saved,
  whereOf,
  withDraft,
  writeDrafts,
  type DraftScope,
  type Owed,
} from './drafts.js'

const scope: DraftScope = { person: 'ada', workspace: 'northwind' }
const LAPTOP = 'laptop'
const PHONE = 'phone'
const t1 = ThreadId.make('t1')
const t2 = ThreadId.make('t2')
const inThread = (thread: ThreadId) => DraftPlace.cases.InThread.make({ thread })
const ada = (thread: ThreadId) => whereOf(scope, inThread(thread))

/** A draft as the server lists it, saved a second after the revision before it. */
const kept = (place: DraftPlace, text: string, revision: number, device: string): Draft => ({
  place,
  text,
  revision,
  savedAt: revision * 1000,
  device,
})

/** The one thing a device owes for a place, as `owed` reports it. */
const owing = (drafts: ReturnType<typeof withDraft>, where: string): Owed => {
  const found = owed(drafts, scope).find((place) => place.where === where)
  if (found === undefined) throw new Error(`Nothing is owed for ${where}.`)
  return found
}

describe('a device keeping drafts', () => {
  it('keeps what was typed in each place apart, and per Person', () => {
    const typed = withDraft(withDraft(noDrafts, ada(t1), 'Ask Dami for', 1), ada(t2), 'Draft', 2)
    expect(draftIn(typed, ada(t1))).toBe('Ask Dami for')
    expect(draftIn(typed, ada(t2))).toBe('Draft')
    expect(
      draftIn(typed, draftPlace('ben', { workspace: 'northwind', thread: Option.some(t1) })),
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

  it('has no draft once words nobody else has seen are emptied', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami for', 1)
    const sent = owing(typed, ada(t1))
    // The server refused the place for good, so it holds nothing to clear.
    const local = abandoned(typed, sent)
    expect(withDraft(local, ada(t1), '  ', 2)).toEqual(noDrafts)
  })

  it('lets the oldest go when a device holds more than it keeps', () => {
    const many = Array.from({ length: 60 }, (_, index) => index).reduce(
      (drafts, index) =>
        withDraft(drafts, ada(ThreadId.make(`t${index}`)), `words ${index}`, index),
      noDrafts,
    )
    expect(many.entries).toHaveLength(50)
    expect(draftIn(many, ada(ThreadId.make('t59')))).toBe('words 59')
    expect(draftIn(many, ada(ThreadId.make('t0')))).toBe('')
  })

  it('survives being stored, and reads anything else as no drafts', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami for the signed NDA', 1)
    expect(readDrafts(Option.some(writeDrafts(typed)))).toEqual(typed)
    expect(readDrafts(Option.none())).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":2,"entries":[{"where":'))).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":1,"entries":[]}'))).toEqual(noDrafts)
  })
})

describe('naming a place', () => {
  it('reads a name back as the place it was made from', () => {
    const start = DraftPlace.cases.NewThread.make({})
    expect(placeOf(scope, whereOf(scope, start))).toEqual(Option.some(start))
    expect(placeOf(scope, whereOf(scope, inThread(t1)))).toEqual(Option.some(inThread(t1)))
  })

  it('does not read another Person or another workspace as this one', () => {
    expect(placeOf({ person: 'ben', workspace: 'northwind' }, ada(t1))).toEqual(Option.none())
    expect(placeOf({ person: 'ada', workspace: 'personal' }, ada(t1))).toEqual(Option.none())
  })
})

describe('drafts following the Person', () => {
  it('owes the server the latest words of a place, once', () => {
    const typed = withDraft(withDraft(noDrafts, ada(t1), 'Ask', 1), ada(t1), 'Ask Dami', 2)
    expect(owed(typed, scope)).toEqual([{ where: ada(t1), place: inThread(t1), text: 'Ask Dami' }])
  })

  it('owes nothing for another workspace until the Person is there', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    expect(owed(typed, { person: 'ada', workspace: 'personal' })).toEqual([])
  })

  it('stops owing words the server kept, and ignores that save coming back', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const mine = kept(inThread(t1), 'Ask Dami', 1, LAPTOP)
    const confirmed = saved(
      typed,
      owing(typed, ada(t1)),
      DraftSaved.cases.Kept.make({ draft: mine }),
    )
    expect(owed(confirmed, scope)).toEqual([])
    expect(heard(confirmed, scope, LAPTOP, [mine])).toEqual(confirmed)
  })

  it('never takes its own echo as words, even one that arrives before the answer', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const more = withDraft(typed, ada(t1), 'Ask Dami for the NDA', 2)
    const echoed = heard(more, scope, LAPTOP, [kept(inThread(t1), 'Ask Dami', 1, LAPTOP)])
    expect(draftIn(echoed, ada(t1))).toBe('Ask Dami for the NDA')
    expect(owing(echoed, ada(t1)).text).toBe('Ask Dami for the NDA')
  })

  it('still owes words typed while a save was on its way', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const sent = owing(typed, ada(t1))
    const more = withDraft(typed, ada(t1), 'Ask Dami for the NDA', 2)
    const answered = saved(
      more,
      sent,
      DraftSaved.cases.Kept.make({ draft: kept(inThread(t1), 'Ask Dami', 1, LAPTOP) }),
    )
    expect(owing(answered, ada(t1)).text).toBe('Ask Dami for the NDA')
  })

  it("replaces idle words with another device's newer draft", () => {
    const fromPhone = heard(noDrafts, scope, LAPTOP, [kept(inThread(t1), 'Ask Dami', 1, PHONE)])
    expect(draftIn(fromPhone, ada(t1))).toBe('Ask Dami')
    const later = heard(fromPhone, scope, LAPTOP, [
      kept(inThread(t1), 'Ask Dami for the NDA', 2, PHONE),
    ])
    expect(draftIn(later, ada(t1))).toBe('Ask Dami for the NDA')
    expect(owed(later, scope)).toEqual([])
  })

  it('does not go back to an older revision that arrives late', () => {
    const current = heard(noDrafts, scope, LAPTOP, [kept(inThread(t1), 'Second', 2, PHONE)])
    const late = heard(current, scope, LAPTOP, [kept(inThread(t1), 'First', 1, PHONE)])
    expect(draftIn(late, ada(t1))).toBe('Second')
  })

  it("does not replace words being typed with another device's draft", () => {
    const typing = withDraft(noDrafts, ada(t1), 'Typing on the laptop', 1)
    const arrived = heard(typing, scope, LAPTOP, [kept(inThread(t1), 'From the phone', 4, PHONE)])
    expect(draftIn(arrived, ada(t1))).toBe('Typing on the laptop')
    expect(owing(arrived, ada(t1)).text).toBe('Typing on the laptop')
  })

  it('clears a place here when it was cleared, or sent, on another device', () => {
    const fromPhone = heard(noDrafts, scope, LAPTOP, [kept(inThread(t1), 'Ask Dami', 1, PHONE)])
    expect(heard(fromPhone, scope, LAPTOP, [])).toEqual(noDrafts)
  })

  it('tells the server when a place is emptied here, and forgets it once told', () => {
    const fromPhone = heard(noDrafts, scope, LAPTOP, [kept(inThread(t1), 'Ask Dami', 1, PHONE)])
    const emptied = withDraft(fromPhone, ada(t1), '', 2)
    expect(draftIn(emptied, ada(t1))).toBe('')
    const sent = owing(emptied, ada(t1))
    expect(sent.text).toBe('')
    // The list that still has the words is older than the emptying and must not bring them back.
    expect(
      draftIn(heard(emptied, scope, LAPTOP, [kept(inThread(t1), 'Ask Dami', 1, PHONE)]), ada(t1)),
    ).toBe('')
    expect(saved(emptied, sent, DraftSaved.cases.Cleared.make({ place: inThread(t1) }))).toEqual(
      noDrafts,
    )
  })

  it('takes words written after a clear, though the count started again', () => {
    const fifth = heard(noDrafts, scope, LAPTOP, [kept(inThread(t1), 'Old', 5, PHONE)])
    // The laptop was away while the phone cleared the place and wrote in it again.
    const again = heard(fifth, scope, LAPTOP, [
      { place: inThread(t1), text: 'New', revision: 1, savedAt: 9000, device: PHONE },
    ])
    expect(draftIn(again, ada(t1))).toBe('New')
  })

  it('saves what was typed offline when the server is heard again', () => {
    const fromPhone = heard(noDrafts, scope, LAPTOP, [
      kept(inThread(t1), 'Ask Dami', 1, PHONE),
      kept(inThread(t2), 'Idle here', 1, PHONE),
    ])
    const offline = withDraft(fromPhone, ada(t1), 'Ask Dami, typed on the train', 2)
    // Meanwhile the phone changed both places.
    const back = heard(offline, scope, LAPTOP, [
      kept(inThread(t1), 'Phone version', 2, PHONE),
      kept(inThread(t2), 'Changed on the phone', 2, PHONE),
    ])
    expect(owed(back, scope)).toEqual([
      { where: ada(t1), place: inThread(t1), text: 'Ask Dami, typed on the train' },
    ])
    expect(draftIn(back, ada(t2))).toBe('Changed on the phone')
  })

  it('keeps two places independent', () => {
    const typing = withDraft(noDrafts, ada(t1), 'Typing here', 1)
    const arrived = heard(typing, scope, LAPTOP, [kept(inThread(t2), 'From the phone', 1, PHONE)])
    expect(draftIn(arrived, ada(t1))).toBe('Typing here')
    expect(draftIn(arrived, ada(t2))).toBe('From the phone')
    expect(owed(arrived, scope).map((place) => place.where)).toEqual([ada(t1)])
  })

  it("leaves another workspace's drafts alone when this one's list arrives", () => {
    const personal: DraftScope = { person: 'ada', workspace: 'personal' }
    const elsewhere = heard(noDrafts, personal, LAPTOP, [
      kept(inThread(t2), 'In my own space', 1, PHONE),
    ])
    const here = heard(elsewhere, scope, LAPTOP, [])
    expect(draftIn(here, whereOf(personal, inThread(t2)))).toBe('In my own space')
  })

  it('stops owing words for a Thread that is gone, and keeps them on the device', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const given = abandoned(typed, owing(typed, ada(t1)))
    expect(owed(given, scope)).toEqual([])
    expect(draftIn(given, ada(t1))).toBe('Ask Dami')
    // Nothing was ever taken from the server for it, so an empty list does not clear it.
    expect(draftIn(heard(given, scope, LAPTOP, []), ada(t1))).toBe('Ask Dami')
  })
})
