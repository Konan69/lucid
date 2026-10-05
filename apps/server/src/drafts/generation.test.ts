import { describe, expect, layer } from '@effect/vitest'
import { DraftPlace, DraftSaved, DraftWorkspace, SaveDraftRequest } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { draftHandlers } from './handlers.ts'
import { draftStoreLayer } from './store.ts'
import { drafts } from './tables.ts'
import { current, fixture, signedIn, type Caller } from './testing.ts'

const testLayer = draftStoreLayer.pipe(
  Layer.provideMerge(changesLayer),
  Layer.provideMerge(testDatabaseLayer),
)
const place = DraftPlace.cases.NewThread.make({})

/** Generation assertions cross the public handler and real PostgreSQL transaction boundary. */
const save = (caller: Caller, text: string) =>
  draftHandlers
    .SaveDraft(SaveDraftRequest.make({ place, text, device: 'generation-test' }))
    .pipe(signedIn(caller))

describe.skipIf(!testDatabaseConfigured)('Person draft generation', () => {
  layer(testLayer)((it) => {
    it.effect(
      'every save and clear advances one counter across workspaces, even an empty clear',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          expect(yield* current(test.personal)).toEqual({
            workspace: DraftWorkspace.cases.Personal.make({}),
            generation: 0,
            drafts: [],
          })
          expect(yield* current(test.member)).toEqual({
            workspace: DraftWorkspace.cases.Company.make({ company: test.company.id }),
            generation: 0,
            drafts: [],
          })
          yield* TestClock.setTime(1_800_000_000_000)
          const first = yield* save(test.personal, 'personal')
          const second = yield* save(test.member, 'Company')
          expect(first.generation).toBe(1)
          expect(second.generation).toBe(2)
          expect(yield* save(test.personal, ' ')).toEqual(
            DraftSaved.cases.Cleared.make({ place, generation: 3 }),
          )
          expect(yield* save(test.personal, '\t')).toEqual(
            DraftSaved.cases.Cleared.make({ place, generation: 4 }),
          )
          const restored = yield* save(test.personal, 'personal again')
          expect(restored.generation).toBe(5)
          DraftSaved.match(restored, {
            Kept: ({ draft, generation }) => expect(draft.revision).toBe(generation),
            Cleared: () => expect.fail('Non-empty save cleared words'),
          })
          expect((yield* current(test.personal)).drafts).toMatchObject([
            { revision: 5, text: 'personal again' },
          ])
          expect((yield* current(test.member)).drafts).toMatchObject([
            { revision: 2, text: 'Company' },
          ])
          expect((yield* current(test.personal)).generation).toBe(5)
          expect((yield* current(test.member)).generation).toBe(5)
          yield* save(test.foreign, 'another Person')
          yield* save(test.foreign, ' ')
          expect((yield* current(test.personal)).generation).toBe(5)
          expect((yield* current(test.foreign)).generation).toBe(2)
        }).pipe(Effect.scoped),
    )

    it.effect('concurrent first saves in different workspaces return consecutive generations', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const answers = yield* Effect.all(
          [save(test.personal, 'personal'), save(test.member, 'Company')],
          { concurrency: 'unbounded' },
        )
        expect(answers.map((answer) => answer.generation).toSorted((a, b) => a - b)).toEqual([1, 2])
        for (const answer of answers) {
          DraftSaved.match(answer, {
            Kept: ({ draft, generation }) => expect(draft.revision).toBe(generation),
            Cleared: () => expect.fail('Non-empty save cleared words'),
          })
        }
        expect((yield* current(test.personal)).generation).toBe(2)
        expect((yield* current(test.member)).generation).toBe(2)
      }).pipe(Effect.scoped),
    )

    it.effect('concurrent lists pair their snapshot generation with precisely its latest row', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.personal, 'initial')
        // All writes replace one place, so every valid snapshot must pair its counter with that
        // exact revision. Unbounded readers and writers exercise commits between the two reads.
        const reads = yield* Effect.all(
          Array.from({ length: 20 }, (_, index) =>
            Effect.all([save(test.personal, `write ${index}`), current(test.second)], {
              concurrency: 'unbounded',
            }).pipe(Effect.map(([, listed]) => listed)),
          ),
          { concurrency: 'unbounded' },
        )
        for (const listed of reads) {
          expect(listed.drafts).toHaveLength(1)
          expect(listed.drafts[0]).toMatchObject({ revision: listed.generation })
        }
        expect((yield* current(test.personal)).generation).toBe(21)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'legacy revisions in any workspace seed reads and the first clear without resetting order',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          // This is the pre-counter persisted shape, not a mocked store; its newer Company
          // revision must also govern an empty Personal list and a Personal clear.
          yield* database.run(
            database.insert(drafts).values({
              personId: test.member.actor.person.id,
              companyId: test.company.id,
              place: 'NewThread',
              threadId: null,
              text: 'legacy Company words',
              revision: 40,
              savedAt: 0,
              device: 'old-device',
            }),
          )
          expect(yield* current(test.personal)).toEqual({
            workspace: DraftWorkspace.cases.Personal.make({}),
            generation: 40,
            drafts: [],
          })
          expect((yield* current(test.member)).generation).toBe(40)
          expect((yield* current(test.member)).drafts).toMatchObject([{ revision: 40 }])
          expect(yield* save(test.member, ' ')).toEqual(
            DraftSaved.cases.Cleared.make({ place, generation: 41 }),
          )
          expect((yield* current(test.personal)).generation).toBe(41)
          const restored = yield* save(test.member, 'new words')
          expect(restored.generation).toBe(42)
          expect((yield* current(test.member)).drafts).toMatchObject([{ revision: 42 }])
        }).pipe(Effect.scoped),
    )
  })
})
