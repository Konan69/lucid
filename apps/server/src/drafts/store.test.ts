import { describe, expect, layer } from '@effect/vitest'
import { DraftPlace, DraftSaved, SaveDraftRequest, ThreadId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { nextValue } from '../live/testing.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { draftHandlers } from './handlers.ts'
import { draftStoreLayer } from './store.ts'
import { drafts } from './tables.ts'
import { current, fixture, observing, signedIn, thread, type Caller } from './testing.ts'

const testLayer = Layer.mergeAll(draftStoreLayer, threadStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const at = 1_800_000_000_000
const newThread = DraftPlace.cases.NewThread.make({})

/** Calls the public write handler with the exact schema owned by the committed contract. */
const save = (caller: Caller, place: DraftPlace, text: string) =>
  draftHandlers
    .SaveDraft(SaveDraftRequest.make({ place, text, device: 'laptop' }))
    .pipe(signedIn(caller))

describe.skipIf(!testDatabaseConfigured)('cross-device drafts', () => {
  layer(testLayer)((it) => {
    it.effect('save is emitted by an open watch with server time and revision one', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* TestClock.setTime(at)
        const watch = yield* observing(test.personal)
        expect(watch.initial.drafts).toEqual([])
        const saved = yield* save(test.personal, newThread, '  unfinished words  ')
        expect(saved).toEqual(
          DraftSaved.cases.Kept.make({
            draft: {
              place: newThread,
              text: '  unfinished words  ',
              revision: 1,
              savedAt: at,
              device: 'laptop',
            },
          }),
        )
        const emitted = yield* nextValue(watch)
        DraftSaved.match(saved, {
          Kept: ({ draft }) => expect(emitted.drafts).toEqual([draft]),
          Cleared: () => expect.fail('Save cleared non-empty words'),
        })
      }).pipe(Effect.scoped),
    )

    it.effect('a second save increments revision and replaces words and device', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.personal, newThread, 'first')
        yield* TestClock.setTime(at)
        const saved = yield* draftHandlers
          .SaveDraft(SaveDraftRequest.make({ place: newThread, text: 'second', device: 'phone' }))
          .pipe(signedIn(test.personal))
        DraftSaved.match(saved, {
          Kept: ({ draft }) =>
            expect(draft).toMatchObject({
              text: 'second',
              revision: 2,
              savedAt: at,
              device: 'phone',
            }),
          Cleared: () => expect.fail('Save cleared non-empty words'),
        })
        expect((yield* current(test.personal)).drafts).toHaveLength(1)
        expect((yield* current(test.personal)).drafts[0]).toMatchObject({
          text: 'second',
          revision: 2,
        })
      }).pipe(Effect.scoped),
    )

    it.effect('whitespace clears the place and emits an empty list', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.personal, newThread, 'first')
        const watch = yield* observing(test.personal)
        expect(watch.initial.drafts).toHaveLength(1)
        expect(yield* save(test.personal, newThread, ' \t\n ')).toEqual(
          DraftSaved.cases.Cleared.make({ place: newThread }),
        )
        expect((yield* nextValue(watch)).drafts).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('another Person never receives unsent words in the same Company', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.member, newThread, 'private words')
        expect((yield* current(test.foreign)).drafts).toEqual([])
        expect((yield* current(test.member)).drafts).toHaveLength(1)
      }).pipe(Effect.scoped),
    )

    it.effect('saving or clearing an inaccessible or missing Thread is NotFound', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const hidden = yield* thread(test.foreign)
        for (const id of [hidden, ThreadId.make(crypto.randomUUID())]) {
          for (const text of ['words', ' ']) {
            const result = yield* Effect.result(
              save(test.member, DraftPlace.cases.InThread.make({ thread: id }), text),
            )
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) expect(result.failure._tag).toBe('NotFound')
          }
        }
      }).pipe(Effect.scoped),
    )

    it.effect('NewThread places are separate in personal and Company workspaces', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.personal, newThread, 'personal')
        yield* save(test.member, newThread, 'company')
        yield* save(test.member, newThread, 'company revision')
        expect((yield* current(test.personal)).drafts).toMatchObject([
          { text: 'personal', revision: 1 },
        ])
        expect((yield* current(test.member)).drafts).toMatchObject([
          { text: 'company revision', revision: 2 },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('cross-workspace Thread saves belong to the Thread workspace', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* thread(test.member)
        const place = DraftPlace.cases.InThread.make({ thread: id })
        yield* save(test.personal, place, 'Company work from a personal-space link')
        yield* save(test.member, place, 'replacement')
        expect((yield* current(test.personal)).drafts).toEqual([])
        expect((yield* current(test.member)).drafts).toMatchObject([
          { place, text: 'replacement', revision: 2 },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('fifty cap drops the oldest only in the saved workspace, newest first', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* save(test.member, newThread, 'Company keeps its draft')
        yield* TestClock.setTime(at)
        yield* save(test.personal, newThread, 'oldest')
        for (let i = 1; i <= 50; i++) {
          yield* TestClock.setTime(at + i)
          const id = yield* thread(test.personal)
          yield* save(test.personal, DraftPlace.cases.InThread.make({ thread: id }), `words ${i}`)
        }
        const listed = (yield* current(test.personal)).drafts
        expect(listed).toHaveLength(50)
        expect(listed.map((draft) => draft.text)).toEqual(
          Array.from({ length: 50 }, (_, i) => `words ${50 - i}`),
        )
        expect((yield* current(test.member)).drafts).toMatchObject([
          { text: 'Company keeps its draft' },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('Thread deletion cascades its draft and refreshes the owner watch', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* thread(test.personal)
        yield* save(test.personal, DraftPlace.cases.InThread.make({ thread: id }), 'words')
        const watch = yield* observing(test.personal)
        yield* (yield* ThreadStore).remove(test.personal.actor.person.id, id)
        expect((yield* nextValue(watch)).drafts).toEqual([])
        const database = yield* Database
        expect(
          yield* database.run(database.select().from(drafts).where(eq(drafts.threadId, id))),
        ).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('a Thread no longer visible is excluded before the draft list limit', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* thread(test.foreign)
        const database = yield* Database
        yield* database.run(
          database.update(threads).set({ audience: 'company' }).where(eq(threads.id, id)),
        )
        yield* save(test.member, DraftPlace.cases.InThread.make({ thread: id }), 'shared work')
        expect((yield* current(test.member)).drafts).toHaveLength(1)
        yield* database.run(
          database.update(threads).set({ audience: 'private' }).where(eq(threads.id, id)),
        )
        expect((yield* current(test.member)).drafts).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('one device save reaches both subscriptions of the same Person', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const laptop = yield* observing(test.personal)
        const phone = yield* observing(test.second)
        yield* save(test.personal, newThread, 'both devices')
        const [onLaptop, onPhone] = yield* Effect.all([nextValue(laptop), nextValue(phone)], {
          concurrency: 2,
        })
        expect(onLaptop).toEqual(onPhone)
        expect(onPhone.drafts).toMatchObject([{ text: 'both devices', revision: 1 }])
      }).pipe(Effect.scoped),
    )

    it.effect('concurrent device saves retain every revision and enforce the workspace cap', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const places = yield* Effect.forEach(Array.from({ length: 51 }), () =>
          thread(test.personal).pipe(
            Effect.map((id) => DraftPlace.cases.InThread.make({ thread: id })),
          ),
        )
        yield* Effect.forEach(places, (place) => save(test.personal, place, 'parallel'), {
          concurrency: 4,
        })
        expect((yield* current(test.personal)).drafts).toHaveLength(50)
        const database = yield* Database
        expect(
          yield* database.run(
            database
              .select()
              .from(drafts)
              .where(eq(drafts.personId, test.personal.actor.person.id)),
          ),
        ).toHaveLength(50)
        // Save one surviving place on two devices at once: the returning revisions must differ,
        // and the latest one must be the durable whole-text winner, with no read/increment race.
        const [kept] = (yield* current(test.personal)).drafts
        if (kept === undefined) expect.fail('The cap removed every draft')
        const saved = yield* Effect.all(
          [
            save(test.personal, kept.place, 'laptop wins'),
            save(test.second, kept.place, 'phone wins'),
          ],
          { concurrency: 2 },
        )
        const returnedDrafts = saved.map((answer) =>
          DraftSaved.match(answer, {
            Kept: ({ draft }) => draft,
            Cleared: () => expect.fail('A concurrent save cleared non-empty words'),
          }),
        )
        expect(returnedDrafts.map((draft) => draft.revision).toSorted((a, b) => a - b)).toEqual([
          2, 3,
        ])
        const winner = returnedDrafts.find((draft) => draft.revision === 3)
        expect(winner).toBeDefined()
        expect(
          (yield* current(test.personal)).drafts.find((draft) => draft.revision === 3),
        ).toEqual(winner)
      }).pipe(Effect.scoped),
    )
  })
})
