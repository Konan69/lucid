import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { DecisionModel } from 'effect/ai'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { Review } from './policy.ts'
import { Reviewer, reviewerLayer } from './review.ts'
import {
  connectionAction,
  delivery,
  fixture,
  history,
  recordRuns,
  storeServices,
} from './testing.ts'

/** A hand-answered history or decision boundary establishes entry before the deadline moves. */
const stalled = (
  threadId: Parameters<typeof delivery>[0],
  entered: Deferred.Deferred<void>,
  phase: 'history' | 'decision',
) =>
  reviewerLayer.pipe(
    Layer.provideMerge(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            phase === 'decision'
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.die('A stalled history must never reach the decision provider'),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(
        Runtime,
        phase === 'history'
          ? {
              conversation: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            }
          : history([delivery(threadId, 'now', null, 'Update the project')]),
      ),
    ),
  )

/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('The reviewer', () => {
    it.effect('gives up at three seconds and leaves the action unreviewed', () =>
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
            const entered = yield* Deferred.make<void>()
            const review = Effect.fn('Reviewer.test.stalled')(function* () {
              const context = yield* Layer.build(stalled(test.personalId, entered, phase))
              return yield* (yield* Reviewer.pipe(Effect.provide(context))).review(
                test.vivid,
                connectionAction,
              )
            })
            const pending = yield* review().pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            yield* TestClock.adjust('2999 millis')
            expect(pending.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust('1 millis')
            expect(yield* Fiber.join(pending)).toEqual(Review.cases.Unreviewed.make({}))
          }
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
