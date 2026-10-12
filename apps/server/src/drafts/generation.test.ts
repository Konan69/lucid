import { describe, expect, layer } from '@effect/vitest'
import { DraftPlace, DraftSaved, DraftWorkspace, SaveDraftRequest } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Layer, Ref } from 'effect'
import * as Statement from 'effect/sql/Statement'
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
    layer(testLayer)('Clock case 1', (it) => {
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
    })

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
        const betweenReads = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const selects = yield* Ref.make(0)
        // Effect 4 Statement.CurrentTransformer is a public execution hook. Pause before the
        // second real SELECT, after PostgreSQL has established the generation snapshot. The
        // queries, rows and transaction are untouched; READ COMMITTED would return mismatched data.
        const barrier: Statement.Transformer = (statement) =>
          Effect.gen(function* () {
            const sql = statement.compile()[0]
            if (/^select\b/iu.test(sql) && /\bfrom "vivid_drafts"/u.test(sql)) {
              const count = yield* Ref.updateAndGet(selects, (value) => value + 1)
              if (count === 2) {
                yield* Deferred.succeed(betweenReads, undefined)
                yield* Deferred.await(release)
              }
            }
            return statement
          })
        const reading = yield* current(test.second).pipe(
          Effect.provideService(Statement.CurrentTransformer, barrier),
          Effect.forkChild,
        )
        yield* Deferred.await(betweenReads)
        expect((yield* save(test.personal, 'committed between the reads')).generation).toBe(2)
        yield* Deferred.succeed(release, undefined)
        const listed = yield* Fiber.join(reading)
        expect(yield* Ref.get(selects)).toBe(2)
        expect(listed.generation).toBe(1)
        expect(listed.drafts).toMatchObject([{ revision: 1, text: 'initial' }])
        expect(listed.drafts).toHaveLength(1)
        const latest = yield* current(test.personal)
        expect(latest.generation).toBe(2)
        expect(latest.drafts).toMatchObject([{ revision: 2, text: 'committed between the reads' }])
      }).pipe(Effect.scoped),
    )

    layer(testLayer)('Clock case 2', (it) => {
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
            expect(yield* save(test.personal, ' ')).toEqual(
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
})
