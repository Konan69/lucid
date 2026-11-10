import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Fiber, Layer, Queue, Ref } from 'effect'
import { ProposedAction } from '@vivid/contracts'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { Gate, gateLayer } from './gate.ts'
import { unbound } from './action.ts'
import { DecisionModel } from 'effect/ai'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { Review } from './policy.ts'
import { Reviewer, reviewerLayer } from './review.ts'
import { delivery, fixture, history, recordRuns, storeServices } from './testing.ts'

/** A hand-answered history or decision boundary establishes entry before the deadline moves. */
const stalled = (
  threadId: Parameters<typeof delivery>[0],
  entered: Queue.Queue<void>,
  phase: 'history' | 'decision',
) =>
  reviewerLayer.pipe(
    Layer.provideMerge(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            phase === 'decision'
              ? Queue.offer(entered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.die('A stalled history must never reach the decision provider'),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(
        Runtime,
        phase === 'history'
          ? { read: () => Queue.offer(entered, undefined).pipe(Effect.andThen(Effect.never)) }
          : history([delivery(threadId, 'now', null, 'Update the project')]),
      ),
    ),
  )

/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('The reviewer', () => {
    it.effect('bounds history and each of two provider attempts at three seconds', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(storeServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          yield* recordRuns(test.personalId, [
            {
              id: 'now',
              personId: test.vivid.person.id,
              origin: StoredRunOrigin.cases.Message.make({}),
              working: true,
            },
          ])
          for (const phase of ['history', 'decision'] as const) {
            const entered = yield* Queue.unbounded<void>()
            const review = Effect.fn('Reviewer.test.stalled')(function* () {
              const context = yield* Layer.build(stalled(test.personalId, entered, phase))
              return yield* (yield* Reviewer.pipe(Effect.provide(context))).review(
                test.vivid,
                test.connectionAction,
              )
            })
            const pending = yield* review().pipe(Effect.forkChild)
            yield* Queue.take(entered)
            yield* TestClock.adjust('2999 millis')
            expect(pending.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust('1 millis')
            if (phase === 'decision') {
              yield* Queue.take(entered)
              yield* TestClock.adjust('2999 millis')
              expect(pending.pollUnsafe()).toBeUndefined()
              yield* TestClock.adjust('1 millis')
            }
            expect(yield* Fiber.join(pending)).toEqual(
              Review.cases.Unreviewed.make({
                reason: phase === 'history' ? 'HistoryDeadline' : 'TimedOut',
              }),
            )
          }
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
    it.effect('a timeout then a success lets the Gate run on Jev’s contained answer', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(storeServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          yield* recordRuns(test.personalId, [
            {
              id: 'now',
              personId: test.vivid.person.id,
              origin: StoredRunOrigin.cases.Message.make({}),
              working: true,
            },
          ])
          const entered = yield* Queue.unbounded<void>()
          const calls = yield* Ref.make(0)
          const model = yield* DecisionModel.make({
            decide: () =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(calls, (value) => value + 1)
                yield* Queue.offer(entered, undefined)
                if (call === 1) return yield* Effect.never
                return {
                  answers: {
                    asked: ScriptedAnswer.cases.Probability.make({ probability: 0.1 }),
                    beyond: ScriptedAnswer.cases.Probability.make({ probability: 0.1 }),
                    consequence: ScriptedAnswer.cases.Classify.make({
                      label: 'contained',
                      probabilities: { contained: 0.95, reaches: 0.04, irreversible: 0.01 },
                    }),
                  },
                  usage: { inputTokens: undefined, outputTokens: undefined },
                }
              }),
          })
          const real = yield* Layer.build(
            gateLayer.pipe(
              Layer.provideMerge(reviewerLayer),
              Layer.provideMerge(Layer.succeed(DecisionModel.DecisionModel, model)),
              Layer.provideMerge(
                Layer.mock(
                  Runtime,
                  history([delivery(test.personalId, 'now', null, 'Organize the project')]),
                ),
              ),
            ),
          )
          const pending = yield* (yield* Gate.pipe(Effect.provide(real)))
            .check(
              test.vivid,
              ProposedAction.make({ ...test.connectionAction, effect: 'destructive' }),
              'Ordinary',
              unbound,
            )
            .pipe(Effect.forkChild)
          yield* Queue.take(entered)
          yield* TestClock.adjust('3 seconds')
          yield* Queue.take(entered)
          expect((yield* Fiber.join(pending))._tag).toBe('Allowed')
          expect(yield* Ref.get(calls)).toBe(2)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
