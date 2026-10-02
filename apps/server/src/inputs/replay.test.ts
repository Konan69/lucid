import { describe, expect, it } from '@effect/vitest'
import { RuntimeUnavailable, Workspace } from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Effect, Exit, Option, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { fixture, Observation, trustTestLayer } from '../approvals/testing.ts'
import { membershipTable } from '../companies/tables.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { DeliverySpeaker } from '../threads/conversation.ts'
import { threads } from '../threads/tables.ts'
import { InputStore, inputStoreLayer } from './store.ts'
import { inputRequests } from './tables.ts'

const question = { question: 'Which day?', options: [], allowsOwnAnswer: true }

/** Answer writes and replay cross the real PostgreSQL seam with explicit failure injection. */
describe.skipIf(!testDatabaseConfigured)('Durable Input answer signals', () => {
  it.effect(
    'a shared Thread answer carries its answerer while continuing the asked Person authority',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const store = yield* InputStore
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'company' })
            .where(eq(threads.id, test.companyId)),
        )
        const request = yield* store.ask(test.companyVivid, question)
        yield* store.answer(test.owner, { id: request.id, answer: 'Monday' })
        expect(yield* Ref.get((yield* Observation).deliveries)).toMatchObject([
          {
            personId: test.member.person.id,
            speaker: DeliverySpeaker.cases.Decider.make({ personId: test.owner.person.id }),
          },
        ])
        expect(yield* store.inThread(test.companyId)).toMatchObject([
          { state: { answeredBy: { id: test.owner.person.id } } },
        ])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a fresh store returns an answer recorded before a crash', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const observed = yield* Observation
      const request = yield* store.ask(test.vivid, question)
      yield* Ref.set(observed.changesDefect, true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(store.answer(test.personal, { id: request.id, answer: 'Monday' })),
        ),
      ).toBe(true)
      expect(yield* Ref.get(observed.deliveries)).toEqual([])
      yield* Ref.set(observed.changesDefect, false)
      yield* TestClock.adjust('30 seconds')
      yield* Effect.gen(function* () {
        yield* (yield* InputStore).replay()
      }).pipe(Effect.provide(inputStoreLayer))
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toEqual([
        expect.objectContaining({
          idempotencyKey: `answer-${request.id}`,
          message: expect.objectContaining({ body: 'Monday' }),
        }),
      ])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a transient admission failure preserves the answer and the key', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const observed = yield* Observation
      const request = yield* store.ask(test.vivid, question)
      yield* Ref.set(
        observed.deliveryFailure,
        Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
      )
      yield* store.answer(test.personal, { id: request.id, answer: 'Monday' })
      yield* Ref.set(observed.deliveryFailure, Option.none())
      yield* TestClock.adjust('30 seconds')
      yield* store.replay()
      yield* store.replay()
      expect(
        (yield* Ref.get(observed.deliveries)).map((delivery) => delivery.idempotencyKey),
      ).toEqual([`answer-${request.id}`, `answer-${request.id}`])
      expect((yield* store.inThread(test.personalId))[0]).toMatchObject({
        state: { answer: 'Monday' },
      })
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect(
    'Thread deletion cascades waiting and owed Input requests and never replays tombstones',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* InputStore
        const observed = yield* Observation
        const database = yield* Database
        const request = yield* store.ask(test.vivid, question)
        yield* Ref.set(observed.changesDefect, true)
        yield* Effect.exit(store.answer(test.personal, { id: request.id, answer: 'Monday' }))
        yield* Ref.set(observed.changesDefect, false)
        yield* store.ask(test.vivid, question)
        yield* database.run(database.delete(threads).where(eq(threads.id, test.personalId)))
        expect(yield* store.inThread(test.personalId)).toEqual([])
        expect(
          yield* database.run(
            database
              .select()
              .from(inputRequests)
              .where(eq(inputRequests.threadId, test.personalId)),
          ),
        ).toEqual([])
        yield* store.replay()
        expect(yield* Ref.get(observed.deliveries)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('membership loss stops replay even if access is later restored', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const observed = yield* Observation
      const database = yield* Database
      const request = yield* store.ask(test.companyVivid, question)
      yield* Ref.set(observed.changesDefect, true)
      yield* Effect.exit(store.answer(test.member, { id: request.id, answer: 'Monday' }))
      yield* Ref.set(observed.changesDefect, false)
      const removed = yield* database.run(
        database
          .delete(membershipTable)
          .where(
            and(
              eq(membershipTable.userId, test.member.person.id),
              eq(
                membershipTable.companyId,
                Workspace.guards.Company(test.member.workspace)
                  ? test.member.workspace.company.id
                  : expect.fail('Company fixture required'),
              ),
            ),
          )
          .returning(),
      )
      yield* store.replay()
      const stopped = yield* returned(
        yield* database.run(
          database
            .select({ signal: inputRequests.signal })
            .from(inputRequests)
            .where(eq(inputRequests.id, request.id)),
        ),
        'stopped Input',
      )
      expect(stopped.signal).toMatchObject({ reason: 'AccessLost' })
      yield* database.run(database.insert(membershipTable).values(removed))
      yield* TestClock.adjust('1 minute')
      yield* store.replay()
      expect(yield* Ref.get(observed.deliveries)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
