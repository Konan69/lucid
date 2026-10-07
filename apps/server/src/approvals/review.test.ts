import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { DecisionModel } from 'effect/unstable/ai'
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

/** The production Reviewer over a provider that never answers and a history that is read at once. */
const stalled = (threadId: Parameters<typeof delivery>[0]) =>
  reviewerLayer.pipe(
    Layer.provideMerge(
      Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide: () => Effect.never })),
    ),
    Layer.provideMerge(
      Layer.mock(Runtime, history([delivery(threadId, 'now', null, 'Update the project')])),
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
          // The stalled reviewer stays scoped to the pending fiber that the deadline interrupts.
          const review = Effect.fn('Reviewer.test.stalled')(function* () {
            const context = yield* Layer.build(stalled(test.personalId))
            return yield* Effect.gen(function* () {
              return yield* (yield* Reviewer).review(test.vivid, connectionAction)
            }).pipe(Effect.provide(context))
          })
          const pending = yield* review().pipe(Effect.forkChild)
          // The deadline covers reading the request and asking, so it holds whichever is slow.
          yield* TestClock.adjust('2999 millis')
          expect(pending.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust('1 millis')
          expect(yield* Fiber.join(pending)).toEqual(Review.cases.Unreviewed.make({}))
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
