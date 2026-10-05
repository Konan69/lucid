import {
  CompanyId,
  DatabaseUnavailable,
  DraftPlace,
  DraftSaved,
  DraftWorkspace,
  ThreadId,
  type Draft,
  type SaveDraftRequest,
} from '@vivid/contracts'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, FiberSet, Option, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { draftIn, noDrafts, whereOf, withDraft, type DraftScope, type Drafts } from './drafts.js'
import type { ProductFailure } from './live.js'
import { makeDraftSync } from './sync.js'

const northwind = DraftWorkspace.cases.Company.make({ company: CompanyId.make('northwind') })
const scope: DraftScope = { person: 'ada', workspace: northwind }
const place = DraftPlace.cases.InThread.make({ thread: ThreadId.make('t1') })
const where = whereOf(scope, place)

/**
 * A device with a store, a socket that can be cut, and a server that keeps what it is sent. Its
 * saves run on the test's own runtime, so resting is a step of the test clock, not a wait.
 */
const device = Effect.fn('Test.device')(function* () {
  const run = yield* FiberSet.makeRuntime()
  let drafts: Drafts = noDrafts
  let online = true
  let revision = 0
  const sent: Array<SaveDraftRequest> = []
  const lost: Result.Result<DraftSaved, ProductFailure> = Result.fail(
    new DatabaseUnavailable({ message: 'The server could not be reached.' }),
  )
  const sync = makeDraftSync({
    device: 'laptop',
    read: () => Option.some(drafts),
    update: (change) => {
      drafts = change(drafts)
      sync.changed()
    },
    scope: () => Option.some(scope),
    threads: () => Option.none(),
    save: (request) =>
      Effect.sync(() => {
        if (!online) return lost
        sent.push(request)
        revision += 1
        const draft: Draft = {
          place: request.place,
          text: request.text,
          device: request.device,
          revision,
          savedAt: revision * 1000,
        }
        return Result.succeed(
          request.text.length === 0
            ? DraftSaved.cases.Cleared.make({ place: request.place, generation: revision })
            : DraftSaved.cases.Kept.make({ draft, generation: revision }),
        )
      }),
    launch: (program) => {
      const fiber = run(program)
      return () => {
        run(Fiber.interrupt(fiber))
      }
    },
  })
  return {
    sent,
    sync,
    drafts: () => drafts,
    type: (text: string) => {
      drafts = withDraft(drafts, where, text, 0)
      sync.changed()
    },
    cut: () => {
      online = false
    },
    mend: () => {
      online = true
    },
  }
})

const rest = TestClock.adjust('700 millis')

describe('saving drafts as they are typed', () => {
  it.effect('holds a list for another workspace until the Person is said to be there', () =>
    Effect.gen(function* () {
      const laptop = yield* device()
      const own = DraftWorkspace.cases.Personal.make({})
      // The Person is in Northwind. A list for their own space is not laid over Northwind.
      laptop.sync.heard({
        workspace: own,
        generation: 5,
        drafts: [{ place, text: 'Mine alone', revision: 5, savedAt: 0, device: 'phone' }],
      })
      expect(draftIn(laptop.drafts(), where)).toBe('')
      // The list for where they are replaces it and is applied.
      laptop.sync.heard({
        workspace: northwind,
        generation: 6,
        drafts: [{ place, text: 'For Northwind', revision: 6, savedAt: 0, device: 'phone' }],
      })
      expect(draftIn(laptop.drafts(), where)).toBe('For Northwind')
    }),
  )

  it.effect('saves a sentence once, after it has rested', () =>
    Effect.gen(function* () {
      const laptop = yield* device()
      laptop.type('Ask')
      yield* TestClock.adjust('300 millis')
      laptop.type('Ask Dami')
      yield* TestClock.adjust('300 millis')
      laptop.type('Ask Dami for the NDA')
      expect(laptop.sent).toEqual([])
      yield* rest
      expect(laptop.sent.map((request) => request.text)).toEqual(['Ask Dami for the NDA'])
    }),
  )

  it.effect('clears the draft everywhere when the composer is emptied', () =>
    Effect.gen(function* () {
      const laptop = yield* device()
      laptop.type('Ask Dami')
      yield* rest
      laptop.type('')
      yield* rest
      expect(laptop.sent.map((request) => request.text)).toEqual(['Ask Dami', ''])
      expect(laptop.drafts().entries).toEqual([])
    }),
  )

  it.effect('keeps words typed offline and saves them when the server is heard again', () =>
    Effect.gen(function* () {
      const laptop = yield* device()
      laptop.cut()
      laptop.type('Typed on the train')
      yield* TestClock.adjust('5 seconds')
      expect(laptop.sent).toEqual([])
      expect(draftIn(laptop.drafts(), where)).toBe('Typed on the train')
      laptop.mend()
      // The socket came back: `WatchDrafts` says what the server holds, which is another draft.
      laptop.sync.heard({
        workspace: northwind,
        generation: 3,
        drafts: [{ place, text: 'From the phone', revision: 3, savedAt: 3000, device: 'phone' }],
      })
      yield* rest
      expect(laptop.sent.map((request) => request.text)).toEqual(['Typed on the train'])
      expect(draftIn(laptop.drafts(), where)).toBe('Typed on the train')
    }),
  )
})

describe('words an earlier build kept', () => {
  it('are left waiting, and nothing is written, when their Thread is not this Person’s here', () => {
    // A device that another Person used before: their old words wait for a Thread this Person
    // does not have. Writing the same drafts back made the store announce a change, which called
    // this again without end, and Home stopped drawing.
    let drafts: Drafts = {
      version: 3,
      entries: [],
      marks: [],
      pending: [{ person: 'grace', thread: ThreadId.make('t9'), text: 'Not Ada’s', at: 1 }],
    }
    let writes = 0
    const sync = makeDraftSync({
      device: 'laptop',
      read: () => Option.some(drafts),
      update: (change) => {
        writes += 1
        drafts = change(drafts)
        sync.changed()
      },
      scope: () => Option.some(scope),
      threads: () => Option.some(new Set([ThreadId.make('t1')])),
      save: () => Effect.never,
      launch: () => () => undefined,
    })
    sync.changed()
    expect(writes).toBe(0)
    expect(drafts.pending).toHaveLength(1)
  })
})
