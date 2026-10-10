import * as Layer from 'effect/Layer'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import {
  AskInputRequest,
  Conflict,
  InputAnswer,
  InputRequestState,
  NotFound,
} from '@vivid/contracts'
import { fixture, Observation, trustTestServices } from '../approvals/testing.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { threads } from '../threads/tables.ts'
import { InputStore } from './store.ts'
import { inputRequests } from './tables.ts'

const question = AskInputRequest.make({
  questions: [
    {
      question: 'Which day works?',
      options: [{ label: 'Monday', detail: 'Start the week' }],
      selection: 'One',
      allowsOwnAnswer: true,
    },
  ],
})

/** I1-I3 preserve waiting rows while testing current reach independently of cached workspace roles. */
/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Input inbox Thread privacy', () => {
    it.effect(
      'I1 making a Company Thread private hides its addressed question even from an owner',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const elsewhere = yield* fixture()
            const database = yield* Database
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            const store = yield* InputStore
            const request = yield* store.ask(
              { ...test.owner, by: 'vivid', threadId: Option.some(test.companyId) },
              question,
            )
            expect(yield* store.inbox(test.owner)).toEqual([request])
            expect(yield* store.inbox(test.other)).toEqual([])
            expect(yield* store.inbox(test.member)).toEqual([])
            expect(
              yield* store.inbox({ ...test.owner, workspace: elsewhere.owner.workspace }),
            ).toEqual([])
            const before = yield* database.run(
              database.select().from(inputRequests).where(eq(inputRequests.id, request.id)),
            )
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'private' })
                .where(eq(threads.id, test.companyId)),
            )
            expect(yield* store.inbox(test.owner)).toEqual([])
            expect(
              yield* database.run(
                database.select().from(inputRequests).where(eq(inputRequests.id, request.id)),
              ),
            ).toEqual(before)
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect(
      'I2 re-sharing restores the same waiting question with its options and timestamps',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            const store = yield* InputStore
            const request = yield* store.ask(
              { ...test.owner, by: 'vivid', threadId: Option.some(test.companyId) },
              question,
            )
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'private' })
                .where(eq(threads.id, test.companyId)),
            )
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            expect(yield* store.inbox(test.owner)).toEqual([request])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect('I3 Membership removal hides a question from the same stale Company Actor', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, test.companyId)),
          )
          const store = yield* InputStore
          const request = yield* store.ask(
            { ...test.owner, by: 'vivid', threadId: Option.some(test.companyId) },
            question,
          )
          expect(yield* store.inbox(test.owner)).toEqual([request])
          const before = yield* database.run(
            database.select().from(inputRequests).where(eq(inputRequests.id, request.id)),
          )
          yield* database.run(
            database
              .delete(membershipTable)
              .where(eq(membershipTable.userId, test.owner.person.id)),
          )
          expect(yield* store.inbox(test.owner)).toEqual([])
          expect(
            yield* database.run(
              database.select().from(inputRequests).where(eq(inputRequests.id, request.id)),
            ),
          ).toEqual(before)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })

  /** Questions use the same once-only persistence boundary as Approvals, with Thread-scoped tenancy. */
  describe.skipIf(!testDatabaseConfigured)('Input request answers', () => {
    it.effect('concurrent answers settle once and deliver one attributed signal', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* InputStore
          const request = yield* store.ask(test.vivid, question)
          const answers = yield* Effect.all(
            [
              Effect.result(
                store.answer(test.personal, {
                  id: request.id,
                  answers: [InputAnswer.cases.Chosen.make({ labels: ['Monday'] })],
                }),
              ),
              Effect.result(
                store.answer(test.personal, {
                  id: request.id,
                  answers: [InputAnswer.cases.Written.make({ words: 'Tuesday' })],
                }),
              ),
            ],
            { concurrency: 2 },
          )
          expect(answers.filter(Result.isSuccess)).toHaveLength(1)
          expect(answers.filter(Result.isFailure).map((answer) => answer.failure)).toEqual([
            expect.any(Conflict),
          ])
          // SKIP LOCKED may defer the signal while the losing answer holds its row lock. Both answers
          // have now returned, so the next real replay pass must deliver the durable debt exactly once.
          yield* store.replay
          const deliveries = yield* Ref.get((yield* Observation).deliveries)
          expect(deliveries).toHaveLength(1)
          expect(deliveries[0]).toMatchObject({
            personId: test.personal.person.id,
            idempotencyKey: `answer-${request.id}`,
            message: { type: 'answer', attributes: { request: request.id } },
          })
          expect(yield* store.inbox(test.personal)).toEqual([])
          const records = yield* store.inThread(test.personalId)
          const first = records[0]
          expect(first).toBeDefined()
          if (first !== undefined) expect(InputRequestState.guards.Answered(first.state)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('a Company owner cannot answer another Member and inbox follows workspace', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* InputStore
          const request = yield* store.ask(test.companyVivid, question)
          expect(yield* store.inbox(test.personal)).toEqual([])
          expect(yield* store.inbox(test.member)).toHaveLength(1)
          expect(yield* store.inbox(test.owner)).toEqual([])
          const answer = yield* Effect.result(
            store.answer(test.owner, {
              id: request.id,
              answers: [InputAnswer.cases.Chosen.make({ labels: ['Monday'] })],
            }),
          )
          expect(Result.isFailure(answer)).toBe(true)
          if (Result.isFailure(answer)) expect(answer.failure).toBeInstanceOf(NotFound)
          expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('a question without a free answer accepts only an offered label', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* InputStore
          const request = yield* store.ask(test.vivid, {
            questions: [{ ...question.questions[0], allowsOwnAnswer: false }],
          })
          const rejected = yield* Effect.result(
            store.answer(test.personal, {
              id: request.id,
              answers: [InputAnswer.cases.Written.make({ words: 'Tuesday' })],
            }),
          )
          expect(Result.isFailure(rejected)).toBe(true)
          const accepted = yield* store.answer(test.personal, {
            id: request.id,
            answers: [InputAnswer.cases.Chosen.make({ labels: ['Monday'] })],
          })
          expect(InputRequestState.guards.Answered(accepted.state)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('asking requires Vivid and the authenticated workspace must match the Thread', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* InputStore
          const person = yield* Effect.result(store.ask(test.personal, question))
          expect(Result.isFailure(person)).toBe(true)
          const wrongWorkspace = yield* Effect.result(
            store.ask({ ...test.companyVivid, threadId: Option.some(test.personalId) }, question),
          )
          expect(Result.isFailure(wrongWorkspace)).toBe(true)
          if (Result.isFailure(wrongWorkspace))
            expect(wrongWorkspace.failure).toBeInstanceOf(NotFound)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
