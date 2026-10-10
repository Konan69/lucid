import { describe, expect, it } from '@effect/vitest'
import {
  DraftListResponse,
  DraftSaved,
  DraftWorkspace,
  MeResponse,
  Person,
  PersonId,
  SaveDraftRequest,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import {
  absorbed,
  draftIn,
  draftPlace,
  noDrafts,
  readDrafts,
  withDraft,
  writeDrafts,
} from '@vivid/state'
import { Effect, Option, Schema } from 'effect'
import { vi } from 'vitest'
import { open, wire } from '../test/browser'

/**
 * A tab that opens on drafts the last visit left in the browser's store, with the Person signed
 * in and the server saving what they type. This is the path where the store's copy is older
 * than the tab's for a while: the store is written after a rest (`data/drafts.ts` `REST_MS`),
 * and the server's answer to a save changes the tab's copy in between.
 *
 * The module under test is the page's own, with the live engine and the draft sync behind it;
 * the browser and the server at the socket's other end are the test's (`test/browser.ts`). The
 * cases run in order on the one page, as a visit does.
 */

const KEY = 'vivid-drafts'

const ada = PersonId.make('ada')
/** The composer that starts a Thread, and one Thread's composer, in Ada's own space. */
const starting = draftPlace(ada, { workspace: 'personal', thread: Option.none() })
const elsewhere = draftPlace(ada, {
  workspace: 'personal',
  thread: Option.some(ThreadId.make('thread-in-the-other-tab')),
})
/** Two Threads open in both tabs, and one only the other tab types in. */
const both = draftPlace(ada, {
  workspace: 'personal',
  thread: Option.some(ThreadId.make('thread-typed-in-by-both-tabs')),
})
const begun = draftPlace(ada, {
  workspace: 'personal',
  thread: Option.some(ThreadId.make('thread-begun-in-the-other-tab')),
})
const beside = draftPlace(ada, {
  workspace: 'personal',
  thread: Option.some(ThreadId.make('thread-beside-in-the-other-tab')),
})

vi.useFakeTimers()
const browser = open()

// The last visit ended with words typed and never saved: they are in the store, still owed.
browser.store.writtenUnheard(
  KEY,
  Option.getOrThrow(writeDrafts(withDraft(noDrafts, starting, 'Words from the last visit', 1))),
)

const { draft } = await import('./drafts')

// The server says who is signed in, holds no drafts of theirs yet, and keeps each one it is sent.
browser.server.says(
  'WatchMe',
  wire(
    MeResponse,
    new MeResponse({
      person: new Person({ id: ada, name: 'Ada', email: 'ada@example.com' }),
      workspace: Workspace.cases.Personal.make({}),
      companies: [],
    }),
  ),
)
browser.server.says(
  'WatchDrafts',
  wire(DraftListResponse, {
    workspace: DraftWorkspace.cases.Personal.make({}),
    generation: 0,
    drafts: [],
  }),
)
const readSave = Schema.decodeUnknownSync(SaveDraftRequest)
const saves: Array<SaveDraftRequest> = []
browser.server.answers('SaveDraft', (payload) => {
  const request = readSave(payload)
  saves.push(request)
  const generation = saves.length
  return wire(
    DraftSaved,
    DraftSaved.cases.Kept.make({
      draft: { ...request, revision: generation, savedAt: 0 },
      generation,
    }),
  )
})

/** Long enough for words to rest, be saved and answered, and the answer to reach the store. */
const SETTLED_MS = 3_000

/**
 * Lets that much of the page's time pass. The page's rest and its save run on the browser's
 * timers, which are Vitest's here (`vi.useFakeTimers` above), not on Effect's clock, so this is
 * the one Promise the cases wait on: it runs every timer due in the span and the promises they
 * settle, and nothing sleeps. `it.live` runs the cases because no Effect clock is involved.
 */
const passes = (ms: number) => Effect.promise(() => vi.advanceTimersByTimeAsync(ms))

/** The drafts the browser's store holds now. */
const stored = () => readDrafts(browser.store.read(KEY))

/**
 * The document the other tab stores while a Person is typing in it: the store's copy as that tab
 * took it in (`absorbed`), and on top its own words, typed and not yet saved by the server.
 */
const typedInOtherTab = (words: ReadonlyArray<readonly [where: string, text: string]>) =>
  Option.getOrThrow(
    writeDrafts(
      words.reduce(
        (drafts, [where, text]) => withDraft(drafts, where, text, 3),
        absorbed(noDrafts, stored()),
      ),
    ),
  )

describe('a tab opened on drafts the last visit left', () => {
  it('shows them', () => {
    expect(draft.in(starting)).toBe('Words from the last visit')
  })

  it.live('keeps newer words the server has saved when the store is full', () =>
    Effect.gen(function* () {
      // A full store answers reads and takes no write, so it goes on holding the last visit's copy.
      browser.store.full = true

      draft.keep(starting, 'Newer words')
      yield* passes(SETTLED_MS)

      expect(saves.map((save) => save.text)).toContain('Newer words')
      // The store's copy is this tab's own older one. It is not another tab's words to take in.
      expect(draft.in(starting)).toBe('Newer words')
      browser.store.full = false
    }),
  )

  it.live('keeps words the server has saved when another tab stores its older copy of them', () =>
    Effect.gen(function* () {
      draft.keep(starting, 'First')
      // Rested and stored, not yet saved: this is the copy the other tab takes in.
      yield* passes(400)
      const early = readDrafts(browser.store.read(KEY))
      expect(draftIn(early, starting)).toBe('First')

      draft.keep(starting, 'First and more')
      yield* passes(SETTLED_MS)
      expect(saves.at(-1)).toMatchObject({ text: 'First and more' })

      // The other tab types in a Thread of its own and stores everything it holds.
      browser.store.writtenElsewhere(
        KEY,
        Option.getOrThrow(
          writeDrafts(withDraft(absorbed(noDrafts, early), elsewhere, 'Typed in the other tab', 2)),
        ),
      )

      expect(draft.in(elsewhere)).toBe('Typed in the other tab')
      expect(draft.in(starting)).toBe('First and more')
    }),
  )

  // The two cases below are one fault. The other tab's document is in the store, this tab has
  // taken it in once, and the server then saves this tab's words, so they are no longer
  // keystrokes nothing may replace. A second taking-in of that same document, at the next write
  // of the store, put the other tab's unsaved words over the ones the server had just saved.

  it.live(
    'keeps words the server has saved after another tab stored other words for the place',
    () =>
      Effect.gen(function* () {
        draft.keep(both, 'Typed here')
        // Rested and stored, not yet saved.
        yield* passes(400)
        const writes = browser.store.writes(KEY)

        browser.store.writtenElsewhere(
          KEY,
          typedInOtherTab([
            [both, 'Typed in the other tab at the same time'],
            [beside, 'Typed beside it in the other tab'],
          ]),
        )

        // Taken in where this tab has nothing unsaved, and nothing written back for it.
        expect(draft.in(beside)).toBe('Typed beside it in the other tab')
        expect(draft.in(both)).toBe('Typed here')
        expect(browser.store.writes(KEY)).toBe(writes)

        // The server saves this tab's words, and the store is written with the answer.
        yield* passes(SETTLED_MS)

        expect(saves.at(-1)).toMatchObject({ text: 'Typed here' })
        expect(draft.in(both)).toBe('Typed here')
        expect(draftIn(stored(), both)).toBe('Typed here')
        // What the other tab typed elsewhere is still here, and in the document this tab stored.
        expect(draft.in(beside)).toBe('Typed beside it in the other tab')
        expect(draftIn(stored(), beside)).toBe('Typed beside it in the other tab')
      }),
  )

  it.live("keeps words added to another tab's and saved, when the store takes no write", () =>
    Effect.gen(function* () {
      browser.store.writtenElsewhere(KEY, typedInOtherTab([[begun, 'Begun in the other tab']]))
      expect(draft.in(begun)).toBe('Begun in the other tab')

      // That write filled the store: it goes on holding the other tab's document.
      browser.store.full = true
      draft.keep(begun, 'Begun in the other tab, finished here')
      yield* passes(SETTLED_MS)

      expect(saves.at(-1)).toMatchObject({ text: 'Begun in the other tab, finished here' })
      expect(draft.in(begun)).toBe('Begun in the other tab, finished here')
      browser.store.full = false
    }),
  )
})
