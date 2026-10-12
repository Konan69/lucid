import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  AnswerInputRequest,
  AskInputRequest,
  Conflict,
  InputAnswer,
  InputRequestState,
  SessionId,
} from '@vivid/contracts'
import { Effect, Layer, Ref, Result, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { Actor } from '../auth/access.ts'
import { fixture, Observation, trustTestServices } from '../approvals/testing.ts'
import { Database, returned } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { inputHandlers } from './handlers.ts'
import { InputStore } from './store.ts'
import { inputRequests } from './tables.ts'

const day = {
  question: 'Which day works?',
  options: [
    { label: 'Monday', detail: 'Start the week.' },
    { label: 'Friday', detail: 'End the week.' },
  ],
  selection: 'One',
  allowsOwnAnswer: false,
} satisfies AskInputRequest['questions'][number]
const topics = {
  question: 'Which topics should we review?',
  options: [
    { label: 'Research', detail: 'Review the sources.' },
    { label: 'Writing', detail: 'Review the draft.' },
  ],
  selection: 'Several',
  allowsOwnAnswer: true,
} satisfies AskInputRequest['questions'][number]
const focus = {
  question: 'What should we focus on?',
  options: [],
  selection: 'One',
  allowsOwnAnswer: true,
} satisfies AskInputRequest['questions'][number]
const detail = { ...day, question: 'Which day should we finish?' }
const pick = (...labels: [string, ...string[]]) => InputAnswer.cases.Chosen.make({ labels })
const write = (words: string) => InputAnswer.cases.Written.make({ words })
const answers = [
  pick('Monday'),
  pick('Research', 'Writing'),
  write('Focus on sources.'),
  pick('Friday'),
] as const
const questions = AskInputRequest.make({ questions: [day, topics, focus, detail] })
const decodeAsk = Schema.decodeUnknownEffect(AskInputRequest)

/** Use the same authenticated context the RPC middleware supplies, with no bypass of store access. */
const signedIn = (actor: Actor) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: actor.person,
      workspace: actor.workspace,
      sessionId: SessionId.make('input-tests'),
    }),
  )

/** Vivid's Thread is authority from middleware, never a field of the tool's request. */
const ask = (test: Effect.Success<ReturnType<typeof fixture>>, request: AskInputRequest) =>
  inputHandlers.AskInput(request).pipe(
    Effect.provideService(
      AuthContext,
      AuthState.Vivid({
        person: test.personal.person,
        workspace: test.personal.workspace,
        threadId: test.personalId,
      }),
    ),
  )

/** All persisted columns must remain identical after refusal, including signal debt and settlement. */
const record = Effect.fn('Inputs.test.record')(function* (id: AnswerInputRequest['id']) {
  const database = yield* Database
  return yield* returned(
    yield* database.run(database.select().from(inputRequests).where(eq(inputRequests.id, id))),
    'Input request',
  )
})

/** Each operation crosses the real store and PostgreSQL; only outgoing notifications/delivery are recorded. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Questions answered together', () => {
    it.effect(
      'stores one and four questions, notifies once per request, and rejects five at ingress',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* InputStore
            const one = yield* store.ask(test.vivid, { questions: [day] })
            const four = (yield* ask(test, questions)).request
            expect(one.questions).toEqual([day])
            expect(four.questions).toEqual(questions.questions)
            expect((yield* record(four.id)).answers).toBeNull()
            const before = yield* store.inThread(test.personalId)
            const five = yield* Effect.result(
              decodeAsk({ questions: [...questions.questions, day] }).pipe(
                Effect.flatMap((request) => ask(test, request)),
              ),
            )
            if (!Result.isFailure(five)) expect.fail('Five questions must be refused')
            expect(five.failure._tag).toBe('SchemaError')
            expect(yield* store.inThread(test.personalId)).toEqual(before)
            expect(yield* Ref.get((yield* Observation).notices)).toMatchObject([
              { title: 'Vivid has a question', body: 'Which day works?' },
              { title: 'Vivid has a question', body: 'Which day works? Three more questions.' },
            ])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    const invalid = [
      { tag: 'InputAnswerCountMismatch', answers: [pick('Monday')] },
      {
        tag: 'InputAnswerUnknownLabel',
        answers: [pick('Tuesday'), answers[1], answers[2], answers[3]],
      },
      {
        tag: 'InputAnswerSeveralForbidden',
        answers: [pick('Monday', 'Friday'), answers[1], answers[2], answers[3]],
      },
      {
        tag: 'InputAnswerRepeatedLabel',
        answers: [answers[0], pick('Research', 'Research'), answers[2], answers[3]],
      },
      {
        tag: 'InputAnswerWrittenForbidden',
        answers: [write('Monday'), answers[1], answers[2], answers[3]],
      },
      { tag: 'InputAnswerEmptyWords', answers: [answers[0], answers[1], write(''), answers[3]] },
      {
        tag: 'InputAnswerEmptyWords',
        answers: [answers[0], answers[1], write(' \n\t '), answers[3]],
      },
      // Free-answer permission permits Written, never an invented Chosen label.
      {
        tag: 'InputAnswerUnknownLabel',
        answers: [answers[0], pick('Other'), answers[2], answers[3]],
      },
    ] satisfies readonly { readonly tag: string; readonly answers: AnswerInputRequest['answers'] }[]
    it.effect('refuses every invalid answer shape through store and handler without writes', () =>
      Effect.gen(function* () {
        for (const scenario of invalid) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(trustTestServices)
              return yield* Effect.gen(function* () {
                const test = yield* fixture()
                const store = yield* InputStore
                const input = yield* store.ask(test.vivid, questions)
                const request = AnswerInputRequest.make({ id: input.id, answers: scenario.answers })
                const before = yield* record(input.id)
                const refused = yield* Effect.result(store.answer(test.personal, request))
                if (!Result.isFailure(refused)) expect.fail('Invalid answers must be refused')
                expect(refused.failure._tag).toBe(scenario.tag)
                expect(refused.failure).toHaveProperty('id', input.id)
                expect(yield* record(input.id)).toEqual(before)
                const handled = yield* Effect.result(
                  inputHandlers.AnswerInput(request).pipe(signedIn(test.personal)),
                )
                expect(handled).toEqual(refused)
                expect(yield* record(input.id)).toEqual(before)
                expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([])
              }).pipe(Effect.scoped, Effect.provide(context))
            }),
          )
        }
      }),
    )

    it.effect(
      'refuses surplus answers, then settles four valid answers once through the handler',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const one = (yield* ask(test, { questions: [day] })).request
            const excess = yield* Effect.result(
              inputHandlers
                .AnswerInput({ id: one.id, answers: [pick('Monday'), pick('Friday')] })
                .pipe(signedIn(test.personal)),
            )
            if (!Result.isFailure(excess)) expect.fail('Surplus answers must be refused')
            expect(excess.failure._tag).toBe('InputAnswerCountMismatch')
            expect(excess.failure).toMatchObject({ expected: 1, received: 2 })
            expect((yield* record(one.id)).status).toBe('waiting')
            const four = (yield* ask(test, questions)).request
            const request = { id: four.id, answers }
            const settled = (yield* inputHandlers
              .AnswerInput(request)
              .pipe(signedIn(test.personal))).request
            expect(InputRequestState.guards.Answered(settled.state)).toBe(true)
            expect(settled.state).toMatchObject({
              answers,
              answeredBy: { id: test.personal.person.id },
            })
            const before = yield* record(four.id)
            const second = yield* Effect.result(
              inputHandlers.AnswerInput(request).pipe(signedIn(test.personal)),
            )
            expect(Result.isFailure(second)).toBe(true)
            if (Result.isFailure(second)) expect(second.failure).toBeInstanceOf(Conflict)
            expect(yield* record(four.id)).toEqual(before)
            expect(yield* Ref.get((yield* Observation).deliveries)).toHaveLength(1)
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect(
      'delivers a single choice alone and several answers as question words then answer words',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* InputStore
            const one = yield* store.ask(test.vivid, { questions: [day] })
            const single = yield* store.answer(test.personal, {
              id: one.id,
              answers: [pick('Monday')],
            })
            expect(InputRequestState.guards.Answered(single.state)).toBe(true)
            const three = yield* store.ask(test.vivid, { questions: [day, topics, focus] })
            yield* store.answer(test.personal, {
              id: three.id,
              answers: [answers[0], answers[1], answers[2]],
            })
            const own = yield* store.ask(test.vivid, { questions: [focus] })
            yield* store.answer(test.personal, {
              id: own.id,
              answers: [write('  Keep these words.  ')],
            })
            const multi = yield* store.ask(test.vivid, { questions: [topics] })
            yield* store.answer(test.personal, {
              id: multi.id,
              answers: [pick('Writing', 'Research')],
            })
            yield* store.replay
            const deliveries = yield* Ref.get((yield* Observation).deliveries)
            expect(deliveries.map((delivery) => delivery.message)).toMatchObject([
              { body: 'Monday' },
              {
                body: 'Which day works? Monday\nWhich topics should we review? Research, Writing\nWhat should we focus on? Focus on sources.',
              },
              { body: '  Keep these words.  ' },
              { body: 'Writing, Research' },
            ])
            expect(yield* Ref.get((yield* Observation).notices)).toContainEqual(
              expect.objectContaining({ body: 'Which day works? Two more questions.' }),
            )
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )
  })
})
