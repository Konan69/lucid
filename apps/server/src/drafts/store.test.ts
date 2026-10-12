import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { DraftPlace, DraftSaved, SaveDraftRequest, ThreadId, Workspace } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Layer, Queue, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, payload } from '../live/testing.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { draftHandlers } from './handlers.ts'
import { DraftStore, draftStoreLayer } from './store.ts'
import { drafts } from './tables.ts'
import {
  beforeTransaction,
  current,
  fixture,
  observing,
  signedIn,
  thread,
  type Caller,
} from './testing.ts'

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
    layer(testLayer)('Watch debounce clock', (it) => {
      it.effect('draft changes announce only their Person and never wake a Company peer', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const peer = yield* observing(test.foreign)
          const notices = yield* (yield* PgClient).listen(CHANNEL)
          yield* save(test.member, newThread, 'private Company draft')
          // The ordered SQL marker fails if Company was included, even though unchanged draft
          // responses would normally be deduplicated and conceal the unnecessary peer reload.
          yield* payload(notices, [Topic.part('drafts')(Topic.person(test.member.actor.person.id))])
          yield* save(test.foreign, newThread, 'peer change is the deterministic barrier')
          yield* payload(notices, [
            Topic.part('drafts')(Topic.person(test.foreign.actor.person.id)),
          ])
          expect((yield* nextValue(peer)).drafts).toMatchObject([
            { text: 'peer change is the deterministic barrier' },
          ])
          expect(yield* Queue.size(peer.values)).toBe(0)
        }).pipe(Effect.scoped),
      )
    })

    it.effect('two People drafting in one shared Thread keep separate words and revisions', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const id = yield* thread(test.member)
        const database = yield* Database
        yield* database.run(
          database.update(threads).set({ audience: 'company' }).where(eq(threads.id, id)),
        )
        const place = DraftPlace.cases.InThread.make({ thread: id })
        yield* save(test.member, place, 'first Person')
        yield* save(test.foreign, place, 'second Person')
        yield* save(test.member, place, 'first Person revised')
        expect((yield* current(test.member)).drafts).toMatchObject([
          { place, text: 'first Person revised', revision: 2 },
        ])
        expect((yield* current(test.foreign)).drafts).toMatchObject([
          { place, text: 'second Person', revision: 1 },
        ])
      }).pipe(Effect.scoped),
    )

    layer(testLayer)('Clock case 1', (it) => {
      it.effect(
        'the just-saved place survives fifty equal-clock drafts and archived rows survive',
        () =>
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            const archived = yield* thread(test.personal)
            yield* save(
              test.personal,
              DraftPlace.cases.InThread.make({ thread: archived }),
              'archived',
            )
            yield* (yield* ThreadStore).patch(test.personal.actor.person.id, archived, {
              archived: true,
            })
            yield* TestClock.setTime(at)
            for (let i = 0; i < 50; i++) {
              const id = yield* thread(test.personal)
              yield* save(
                test.personal,
                DraftPlace.cases.InThread.make({ thread: id }),
                `kept ${i}`,
              )
            }
            // This sorts behind all existing UUID places: old offset(50) trimmed the written row.
            const last = ThreadId.make(`!${crypto.randomUUID()}`)
            yield* database.run(
              database.insert(threads).values({
                id: last,
                personId: test.personal.actor.person.id,
                title: 'Frozen-clock draft',
                titleSource: 'Person',
                updatedAt: at,
              }),
            )
            const place = DraftPlace.cases.InThread.make({ thread: last })
            yield* save(test.personal, place, 'just saved')
            const listed = (yield* current(test.personal)).drafts
            expect(listed).toHaveLength(50)
            expect(listed.map((draft) => draft.revision)).toEqual(
              Array.from({ length: 50 }, (_, i) => 52 - i),
            )
            expect(listed.every((draft) => draft.savedAt === at)).toBe(true)
            expect(listed.find((draft) => draft.text === 'just saved')).toMatchObject({ place })
            expect(listed.find((draft) => draft.text === 'archived')).toBeUndefined()
            const stored = yield* database.run(
              database
                .select()
                .from(drafts)
                .where(eq(drafts.personId, test.personal.actor.person.id)),
            )
            expect(stored).toHaveLength(51)
            expect(stored.find((draft) => draft.threadId === archived)).toMatchObject({
              text: 'archived',
            })
          }).pipe(Effect.scoped),
      )
    })

    layer(testLayer)('Watch debounce clock', (it) => {
      it.effect(
        'archiving hides a draft; archived saves are allowed and unarchiving restores it',
        () =>
          Effect.gen(function* () {
            const test = yield* fixture()
            const id = yield* thread(test.personal)
            const place = DraftPlace.cases.InThread.make({ thread: id })
            yield* save(test.personal, place, 'before archive')
            const watch = yield* observing(test.personal)
            const store = yield* ThreadStore
            yield* store.patch(test.personal.actor.person.id, id, { archived: true })
            expect((yield* nextValue(watch)).drafts).toEqual([])
            const saved = yield* save(test.personal, place, 'written while archived')
            expect(DraftSaved.guards.Kept(saved)).toBe(true)
            expect((yield* current(test.personal)).drafts).toEqual([])
            // Hidden words still advance the Person's counter, so the live list must emit that
            // generation even though its visible rows remain empty.
            expect(yield* nextValue(watch)).toMatchObject({ generation: 2, drafts: [] })
            expect(yield* Queue.size(watch.values)).toBe(0)
            yield* store.patch(test.personal.actor.person.id, id, { archived: false })
            expect((yield* nextValue(watch)).drafts).toMatchObject([
              { place, text: 'written while archived', revision: 2 },
            ])
          }).pipe(Effect.scoped),
      )
    })

    it.effect(
      'a Thread deleted at the former pre-transaction check gap is NotFound at the store',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const id = yield* thread(test.personal)
          const entered = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          const database = yield* Database
          const observed = beforeTransaction(
            database,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          )
          const controlled = Layer.fresh(draftStoreLayer).pipe(
            Layer.provide(Layer.succeed(Database, observed)),
          )
          const request = SaveDraftRequest.make({
            place: DraftPlace.cases.InThread.make({ thread: id }),
            text: 'the Thread was deleted',
            device: 'laptop',
          })
          const context = yield* Layer.build(controlled)
          const saving = yield* Effect.flatMap(DraftStore, (store) =>
            store.save(test.personal.actor, request),
          ).pipe(Effect.result, Effect.forkScoped, Effect.provide(context))
          yield* Deferred.await(entered)
          yield* (yield* ThreadStore).remove(test.personal.actor.person.id, id)
          yield* Deferred.succeed(resume, undefined)
          const result = yield* Fiber.join(saving)
          expect(Result.isFailure(result) && result.failure._tag).toBe('NotFound')
        }).pipe(Effect.scoped),
    )

    layer(testLayer)('Clock case 2', (it) => {
      it.effect('save is emitted by an open watch with server time and revision one', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* TestClock.setTime(at)
          const watch = yield* observing(test.personal)
          expect(watch.initial.drafts).toEqual([])
          const saved = yield* save(test.personal, newThread, '  unfinished words  ')
          expect(saved).toEqual(
            DraftSaved.cases.Kept.make({
              generation: 1,
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
    })

    layer(testLayer)('Clock case 3', (it) => {
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
    })

    layer(testLayer)('Watch debounce clock', (it) => {
      it.effect('whitespace clears the place and emits an empty list', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* save(test.personal, newThread, 'first')
          const watch = yield* observing(test.personal)
          expect(watch.initial.drafts).toHaveLength(1)
          expect(yield* save(test.personal, newThread, ' \t\n ')).toEqual(
            DraftSaved.cases.Cleared.make({ place: newThread, generation: 2 }),
          )
          expect((yield* nextValue(watch)).drafts).toEqual([])
        }).pipe(Effect.scoped),
      )
    })

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
          { text: 'company revision', revision: 3 },
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

    layer(testLayer)('Clock case 4', (it) => {
      it.effect('fifty cap drops the oldest only in the saved workspace, newest first', () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* save(test.member, newThread, 'Company keeps its draft')
          yield* TestClock.setTime(at)
          yield* save(test.personal, newThread, 'oldest')
          for (let i = 1; i <= 50; i++) {
            yield* TestClock.setTime(at - i)
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
    })

    layer(testLayer)('Watch debounce clock', (it) => {
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
    })

    it.effect('a Thread no longer visible is excluded before the draft list limit', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        if (!Workspace.guards.Company(test.member.actor.workspace)) expect.fail('Company required')
        const visible = yield* thread(test.member)
        const visiblePlace = DraftPlace.cases.InThread.make({ thread: visible })
        yield* save(test.member, visiblePlace, 'older visible work')
        // Seed legacy overflow directly: normal saves prune to fifty and would remove the
        // older visible row before this read-side ordering regression could be exercised.
        const hidden = yield* Effect.forEach(Array.from({ length: 51 }), () => thread(test.foreign))
        for (const [index, id] of hidden.entries()) {
          yield* database.run(
            database.insert(drafts).values({
              personId: test.member.actor.person.id,
              companyId: test.member.actor.workspace.company.id,
              place: 'InThread',
              threadId: id,
              text: 'unauthorized newer words',
              revision: index + 2,
              savedAt: at + index,
              device: 'laptop',
            }),
          )
        }
        expect((yield* current(test.member)).drafts).toEqual([
          expect.objectContaining({ place: visiblePlace, text: 'older visible work', revision: 1 }),
        ])
      }).pipe(Effect.scoped),
    )

    layer(testLayer)('Watch debounce clock', (it) => {
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
    })

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
          { concurrency: 'unbounded' },
        )
        const returnedDrafts = saved.map((answer) =>
          DraftSaved.match(answer, {
            Kept: ({ draft }) => draft,
            Cleared: () => expect.fail('A concurrent save cleared non-empty words'),
          }),
        )
        expect(returnedDrafts.map((draft) => draft.revision).toSorted((a, b) => a - b)).toEqual([
          52, 53,
        ])
        expect(saved.map((answer) => answer.generation).toSorted((a, b) => a - b)).toEqual([52, 53])
        const listed = yield* current(test.personal)
        expect(listed.generation).toBe(53)
        const winner = returnedDrafts.find((draft) => draft.revision === 53)
        expect(winner).toBeDefined()
        expect(listed.drafts.find((draft) => draft.revision === 53)).toEqual(winner)
      }).pipe(Effect.scoped),
    )
  })
})
