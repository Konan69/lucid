import {
  CompanyId,
  DraftPlace,
  DraftSaved,
  DraftWorkspace,
  ThreadId,
  type Draft,
  type DraftListResponse,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  abandoned,
  absorbed,
  draftIn,
  draftPlace,
  forgotten,
  heard,
  noDrafts,
  owed,
  placeOf,
  readDrafts,
  resolved,
  saved,
  whereOf,
  withDraft,
  writeDrafts,
  type Drafts,
  type DraftScope,
  type Owed,
} from './drafts.js'

const northwind = DraftWorkspace.cases.Company.make({ company: CompanyId.make('northwind') })
const personal = DraftWorkspace.cases.Personal.make({})
const scope: DraftScope = { person: 'ada', workspace: northwind }
const LAPTOP = 'laptop'
const PHONE = 'phone'
const t1 = ThreadId.make('t1')
const t2 = ThreadId.make('t2')
const inThread = (thread: ThreadId) => DraftPlace.cases.InThread.make({ thread })
const ada = (thread: ThreadId) => whereOf(scope, inThread(thread))

/**
 * A draft as the server lists it. Every draft here was saved at the same instant by the server's
 * clock: order is the counts', and a clock that is frozen or wrong must change nothing.
 */
const kept = (place: DraftPlace, text: string, revision: number, device: string): Draft => ({
  place,
  text,
  revision,
  savedAt: 0,
  device,
})

/** What `WatchDrafts` says for Northwind at one generation. */
const listed = (generation: number, ...drafts: ReadonlyArray<Draft>): DraftListResponse => ({
  workspace: northwind,
  generation,
  drafts,
})

const hear = (drafts: Drafts, list: DraftListResponse) => heard(drafts, scope, LAPTOP, list)

/** The one thing a client owes for a place, as `owed` reports it. */
const owing = (drafts: Drafts, where: string): Owed => {
  const found = owed(drafts, scope).find((place) => place.where === where)
  if (found === undefined) throw new Error(`Nothing is owed for ${where}.`)
  return found
}

/** Types in Thread 1 and has the server keep it at `generation`. */
const typedAndSaved = (text: string, generation: number): Drafts => {
  const typed = withDraft(noDrafts, ada(t1), text, 1)
  return saved(
    typed,
    scope,
    owing(typed, ada(t1)),
    DraftSaved.cases.Kept.make({
      draft: kept(inThread(t1), text, generation, LAPTOP),
      generation,
    }),
  )
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
    const company = draftPlace('ada', { workspace: 'northwind', thread: Option.none() })
    const own = draftPlace('ada', { workspace: 'personal', thread: Option.none() })
    const typed = withDraft(noDrafts, company, 'Confidential: Q3 numbers for', 1)
    expect(draftIn(typed, company)).toBe('Confidential: Q3 numbers for')
    expect(draftIn(typed, own)).toBe('')
  })

  it('has no draft once words nobody else has seen are emptied', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami for', 1)
    // The server refused the place for good, so it holds nothing to clear.
    const local = abandoned(typed, owing(typed, ada(t1)))
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
    const typed = typedAndSaved('Ask Dami for the signed NDA', 4)
    expect(readDrafts(Option.some(writeDrafts(typed)))).toEqual(typed)
    expect(readDrafts(Option.none())).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":3,"entries":[{"where":'))).toEqual(noDrafts)
    expect(readDrafts(Option.some('{"version":9,"entries":[]}'))).toEqual(noDrafts)
  })
})

describe('naming a place', () => {
  it('reads a name back as the place it was made from', () => {
    const start = DraftPlace.cases.NewThread.make({})
    expect(placeOf(scope, whereOf(scope, start))).toEqual(Option.some(start))
    expect(placeOf(scope, whereOf(scope, inThread(t1)))).toEqual(Option.some(inThread(t1)))
  })

  it('names a place the way a composer does', () => {
    expect(whereOf(scope, inThread(t1))).toBe(
      draftPlace('ada', { workspace: 'northwind', thread: Option.some(t1) }),
    )
    expect(
      whereOf({ person: 'ada', workspace: personal }, DraftPlace.cases.NewThread.make({})),
    ).toBe(draftPlace('ada', { workspace: 'personal', thread: Option.none() }))
  })

  it('does not read another Person or another workspace as this one', () => {
    expect(placeOf({ person: 'ben', workspace: northwind }, ada(t1))).toEqual(Option.none())
    expect(placeOf({ person: 'ada', workspace: personal }, ada(t1))).toEqual(Option.none())
  })
})

describe('saving', () => {
  it('owes the server the latest words of a place, once', () => {
    const typed = withDraft(withDraft(noDrafts, ada(t1), 'Ask', 1), ada(t1), 'Ask Dami', 2)
    expect(owed(typed, scope)).toEqual([{ where: ada(t1), place: inThread(t1), text: 'Ask Dami' }])
  })

  it('owes nothing for another workspace until the Person is there', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    expect(owed(typed, { person: 'ada', workspace: personal })).toEqual([])
  })

  it('stops owing words the server kept', () => {
    expect(owed(typedAndSaved('Ask Dami', 4), scope)).toEqual([])
  })

  it('still owes words typed while a save was on its way', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const sent = owing(typed, ada(t1))
    const more = withDraft(typed, ada(t1), 'Ask Dami for the NDA', 2)
    const answered = saved(
      more,
      scope,
      sent,
      DraftSaved.cases.Kept.make({
        draft: kept(inThread(t1), 'Ask Dami', 4, LAPTOP),
        generation: 4,
      }),
    )
    expect(owing(answered, ada(t1)).text).toBe('Ask Dami for the NDA')
  })

  it('stops owing words for a Thread that is gone, and keeps them on the device', () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const given = abandoned(typed, owing(typed, ada(t1)))
    expect(owed(given, scope)).toEqual([])
    expect(draftIn(given, ada(t1))).toBe('Ask Dami')
  })
})

describe('a list from the server', () => {
  it("puts another client's draft in a place that is idle", () => {
    const fromPhone = hear(noDrafts, listed(1, kept(inThread(t1), 'Ask Dami', 1, PHONE)))
    expect(draftIn(fromPhone, ada(t1))).toBe('Ask Dami')
    const later = hear(fromPhone, listed(2, kept(inThread(t1), 'Ask Dami for the NDA', 2, PHONE)))
    expect(draftIn(later, ada(t1))).toBe('Ask Dami for the NDA')
    expect(owed(later, scope)).toEqual([])
  })

  it('does nothing when it is older than a save the server has acknowledged', () => {
    const mine = typedAndSaved('Ask Dami', 7)
    // Read before the save landed: empty, and it used to delete the words just saved.
    expect(hear(mine, listed(6))).toEqual(mine)
    expect(hear(mine, listed(6, kept(inThread(t1), 'Older words', 6, PHONE)))).toEqual(mine)
  })

  it('does nothing when it is older than a list already applied', () => {
    const current = hear(noDrafts, listed(5, kept(inThread(t1), 'Second', 5, PHONE)))
    expect(hear(current, listed(4, kept(inThread(t1), 'First', 4, PHONE)))).toEqual(current)
    expect(hear(current, listed(4))).toEqual(current)
  })

  it('does nothing when it is for a workspace the Person has left', () => {
    const typed = hear(noDrafts, listed(3, kept(inThread(t1), 'Northwind words', 3, PHONE)))
    const own = DraftPlace.cases.NewThread.make({})
    // The Person is in Northwind; a list for their own space arrives late, newer and all.
    const late: DraftListResponse = {
      workspace: personal,
      generation: 9,
      drafts: [kept(own, 'A request for my own space', 9, PHONE)],
    }
    expect(hear(typed, late)).toEqual(typed)
    expect(draftIn(hear(typed, late), whereOf(scope, own))).toBe('')
  })

  it("never takes this client's own save as words", () => {
    const typed = withDraft(noDrafts, ada(t1), 'Ask Dami', 1)
    const more = withDraft(typed, ada(t1), 'Ask Dami for the NDA', 2)
    // The echo of the first save arrives before its answer, while more has been typed.
    const echoed = hear(more, listed(4, kept(inThread(t1), 'Ask Dami', 4, LAPTOP)))
    expect(draftIn(echoed, ada(t1))).toBe('Ask Dami for the NDA')
    expect(owing(echoed, ada(t1)).text).toBe('Ask Dami for the NDA')
    // And once saved, its own draft in a later list changes nothing it shows.
    const mine = typedAndSaved('Ask Dami', 4)
    expect(draftIn(hear(mine, listed(5, kept(inThread(t1), 'Ask Dami', 4, LAPTOP))), ada(t1))).toBe(
      'Ask Dami',
    )
  })

  it('does not replace words being typed', () => {
    const typing = withDraft(noDrafts, ada(t1), 'Typing on the laptop', 1)
    const arrived = hear(typing, listed(4, kept(inThread(t1), 'From the phone', 4, PHONE)))
    expect(draftIn(arrived, ada(t1))).toBe('Typing on the laptop')
    expect(owing(arrived, ada(t1)).text).toBe('Typing on the laptop')
  })

  it('does not go back to a revision the place already holds or has passed', () => {
    const current = hear(noDrafts, listed(5, kept(inThread(t1), 'Second', 5, PHONE)))
    // A later list still carrying an older draft of the place cannot be, but must not regress.
    expect(draftIn(hear(current, listed(6, kept(inThread(t1), 'First', 4, PHONE))), ada(t1))).toBe(
      'Second',
    )
  })

  it('clears a place that was cleared, or sent, on another client', () => {
    const fromPhone = hear(noDrafts, listed(1, kept(inThread(t1), 'Ask Dami', 1, PHONE)))
    expect(draftIn(hear(fromPhone, listed(2)), ada(t1))).toBe('')
    expect(hear(fromPhone, listed(2)).entries).toEqual([])
  })

  it('does not clear a place on a list no newer than what the place holds', () => {
    const fromPhone = hear(noDrafts, listed(3, kept(inThread(t1), 'Ask Dami', 3, PHONE)))
    // The same generation again, as a reconnect sends it, without the draft: not a clear.
    expect(draftIn(hear(fromPhone, listed(3)), ada(t1))).toBe('Ask Dami')
  })

  it('does not clear a place that has unsaved keystrokes', () => {
    const fromPhone = hear(noDrafts, listed(1, kept(inThread(t1), 'Ask Dami', 1, PHONE)))
    const typing = withDraft(fromPhone, ada(t1), 'Ask Dami, and Tolu', 2)
    expect(draftIn(hear(typing, listed(2)), ada(t1))).toBe('Ask Dami, and Tolu')
  })

  it('takes words written after a clear, because the count only rises', () => {
    const first = hear(noDrafts, listed(5, kept(inThread(t1), 'Old', 5, PHONE)))
    // The laptop was away while the phone cleared the place (6) and wrote in it again (7).
    const again = hear(first, listed(7, kept(inThread(t1), 'New', 7, PHONE)))
    expect(draftIn(again, ada(t1))).toBe('New')
  })

  it('tells the server when a place is emptied here, and is not undone by an older list', () => {
    const fromPhone = hear(noDrafts, listed(1, kept(inThread(t1), 'Ask Dami', 1, PHONE)))
    const emptied = withDraft(fromPhone, ada(t1), '', 2)
    const sent = owing(emptied, ada(t1))
    expect(sent.text).toBe('')
    const cleared = saved(
      emptied,
      scope,
      sent,
      DraftSaved.cases.Cleared.make({ place: inThread(t1), generation: 2 }),
    )
    expect(cleared.entries).toEqual([])
    // The list read before the clear still has the words, and is older than the acknowledgement.
    expect(
      draftIn(hear(cleared, listed(1, kept(inThread(t1), 'Ask Dami', 1, PHONE))), ada(t1)),
    ).toBe('')
  })

  it('saves what was typed offline and takes the rest when the server is heard again', () => {
    const fromPhone = hear(
      noDrafts,
      listed(
        2,
        kept(inThread(t1), 'Ask Dami', 1, PHONE),
        kept(inThread(t2), 'Idle here', 2, PHONE),
      ),
    )
    const offline = withDraft(fromPhone, ada(t1), 'Ask Dami, typed on the train', 2)
    const back = hear(
      offline,
      listed(
        4,
        kept(inThread(t1), 'Phone version', 3, PHONE),
        kept(inThread(t2), 'Changed on the phone', 4, PHONE),
      ),
    )
    expect(owed(back, scope)).toEqual([
      { where: ada(t1), place: inThread(t1), text: 'Ask Dami, typed on the train' },
    ])
    expect(draftIn(back, ada(t2))).toBe('Changed on the phone')
  })

  it("leaves another workspace's drafts alone", () => {
    const own: DraftScope = { person: 'ada', workspace: personal }
    const elsewhere = heard(noDrafts, own, LAPTOP, {
      workspace: personal,
      generation: 1,
      drafts: [kept(inThread(t2), 'In my own space', 1, PHONE)],
    })
    expect(draftIn(hear(elsewhere, listed(2)), whereOf(own, inThread(t2)))).toBe('In my own space')
  })
})

describe('two tabs of one browser', () => {
  it("shows the other tab's words in a place that is idle here, and does not owe them", () => {
    const theirs = withDraft(noDrafts, ada(t1), 'Typed in the other tab', 1)
    const mine = absorbed(noDrafts, theirs)
    expect(draftIn(mine, ada(t1))).toBe('Typed in the other tab')
    expect(owed(mine, scope)).toEqual([])
    const more = absorbed(mine, withDraft(theirs, ada(t1), 'Typed in the other tab, and more', 2))
    expect(draftIn(more, ada(t1))).toBe('Typed in the other tab, and more')
  })

  it("never replaces what is being typed here with the other tab's words", () => {
    const mine = withDraft(noDrafts, ada(t1), 'Typing in this tab', 1)
    const theirs = withDraft(noDrafts, ada(t1), 'Typed in the other tab', 2)
    const after = absorbed(mine, theirs)
    expect(draftIn(after, ada(t1))).toBe('Typing in this tab')
    expect(owing(after, ada(t1)).text).toBe('Typing in this tab')
  })

  it('remembers what the other tab had acknowledged, so an old list is still old', () => {
    const mine = absorbed(noDrafts, typedAndSaved('Ask Dami', 7))
    expect(hear(mine, listed(6))).toEqual(mine)
  })
})

describe('the session ending', () => {
  it('forgets what the server has and keeps only what was typed and never taken', () => {
    const both = withDraft(typedAndSaved('Saved on the server', 4), ada(t2), 'Typed offline', 2)
    const after = forgotten(both)
    expect(draftIn(after, ada(t1))).toBe('')
    expect(draftIn(after, ada(t2))).toBe('Typed offline')
    expect(after.marks).toEqual([])
    expect(owed(after, scope).map((place) => place.where)).toEqual([ada(t2)])
  })
})

describe('drafts an earlier build kept', () => {
  const v1 = JSON.stringify({
    version: 1,
    entries: [
      { where: 'ada:northwind:new', text: 'Start a Thread about Q3', at: 30 },
      { where: 'ada:t1', text: 'Ask Dami for the NDA', at: 20 },
      { where: 'ada:t9', text: 'In another workspace', at: 10 },
      { where: 'ada:t2', text: '   ', at: 5 },
    ],
  })

  it('keeps the new-Thread words in their place, owed', () => {
    const read = readDrafts(Option.some(v1))
    const start = draftPlace('ada', { workspace: 'northwind', thread: Option.none() })
    expect(draftIn(read, start)).toBe('Start a Thread about Q3')
    expect(owed(read, scope).map((place) => place.where)).toEqual([start])
  })

  it('holds a Thread’s words until its workspace is known, then puts them in the Thread', () => {
    const read = readDrafts(Option.some(v1))
    expect(read.pending.map((waiting) => waiting.text)).toEqual([
      'In another workspace',
      'Ask Dami for the NDA',
    ])
    const here = resolved(read, scope, new Set([t1, t2]))
    expect(draftIn(here, ada(t1))).toBe('Ask Dami for the NDA')
    expect(owing(here, ada(t1)).text).toBe('Ask Dami for the NDA')
    // The Thread that is not in this workspace's list goes on waiting, and survives the store.
    expect(here.pending.map((waiting) => waiting.text)).toEqual(['In another workspace'])
    expect(readDrafts(Option.some(writeDrafts(here))).pending).toEqual(here.pending)
    const own: DraftScope = { person: 'ada', workspace: personal }
    const there = resolved(here, own, new Set([ThreadId.make('t9')]))
    expect(draftIn(there, whereOf(own, inThread(ThreadId.make('t9'))))).toBe('In another workspace')
    expect(there.pending).toEqual([])
  })

  it('does not hand one Person’s waiting words to another', () => {
    const read = readDrafts(Option.some(v1))
    const ben: DraftScope = { person: 'ben', workspace: northwind }
    expect(resolved(read, ben, new Set([t1]))).toEqual(read)
  })

  it('keeps the places and words of the first build that followed, owed or not', () => {
    const v2 = JSON.stringify({
      version: 2,
      entries: [
        { where: ada(t1), text: 'Typed', at: 2, revision: 3, savedAt: 9, unsaved: true },
        { where: ada(t2), text: 'Saved', at: 1, revision: 5, savedAt: 9, unsaved: false },
      ],
    })
    const read = readDrafts(Option.some(v2))
    expect(draftIn(read, ada(t1))).toBe('Typed')
    expect(draftIn(read, ada(t2))).toBe('Saved')
    expect(owed(read, scope).map((place) => place.where)).toEqual([ada(t1)])
  })
})
