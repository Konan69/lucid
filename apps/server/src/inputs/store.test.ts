import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import { Conflict, InputRequestState, NotFound } from '@vivid/contracts'
import { fixture, Observation, trustTestLayer } from '../approvals/testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { InputStore } from './store.ts'

const question = {
  question: 'Which day works?',
  options: [{ label: 'Monday', detail: 'Start the week' }],
  allowsOwnAnswer: true,
}

/** Questions use the same once-only persistence boundary as Approvals, with Thread-scoped tenancy. */
describe.skipIf(!testDatabaseConfigured)('Input request answers', () => {
  it.effect('concurrent answers settle once and deliver one attributed signal', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const request = yield* store.ask(test.vivid, question)
      const answers = yield* Effect.all(
        [
          Effect.result(store.answer(test.personal, { id: request.id, answer: 'Monday' })),
          Effect.result(store.answer(test.personal, { id: request.id, answer: 'Tuesday' })),
        ],
        { concurrency: 2 },
      )
      expect(answers.filter(Result.isSuccess)).toHaveLength(1)
      expect(answers.filter(Result.isFailure).map((answer) => answer.failure)).toEqual([
        expect.any(Conflict),
      ])
      // SKIP LOCKED may defer the signal while the losing answer holds its row lock. Both answers
      // have now returned, so the next real replay pass must deliver the durable debt exactly once.
      yield* store.replay()
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
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a Company owner cannot answer another Member and inbox follows workspace', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const request = yield* store.ask(test.companyVivid, question)
      expect(yield* store.inbox(test.personal)).toEqual([])
      expect(yield* store.inbox(test.member)).toHaveLength(1)
      expect(yield* store.inbox(test.owner)).toEqual([])
      const answer = yield* Effect.result(
        store.answer(test.owner, { id: request.id, answer: 'Monday' }),
      )
      expect(Result.isFailure(answer)).toBe(true)
      if (Result.isFailure(answer)) expect(answer.failure).toBeInstanceOf(NotFound)
      expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a question without a free answer accepts only an offered label', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const request = yield* store.ask(test.vivid, { ...question, allowsOwnAnswer: false })
      const rejected = yield* Effect.result(
        store.answer(test.personal, { id: request.id, answer: 'Tuesday' }),
      )
      expect(Result.isFailure(rejected)).toBe(true)
      const accepted = yield* store.answer(test.personal, { id: request.id, answer: 'Monday' })
      expect(InputRequestState.guards.Answered(accepted.state)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('asking requires Vivid and the authenticated workspace must match the Thread', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* InputStore
      const person = yield* Effect.result(store.ask(test.personal, question))
      expect(Result.isFailure(person)).toBe(true)
      const wrongWorkspace = yield* Effect.result(
        store.ask({ ...test.companyVivid, threadId: Option.some(test.personalId) }, question),
      )
      expect(Result.isFailure(wrongWorkspace)).toBe(true)
      if (Result.isFailure(wrongWorkspace)) expect(wrongWorkspace.failure).toBeInstanceOf(NotFound)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
