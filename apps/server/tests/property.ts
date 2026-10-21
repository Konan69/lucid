import { Cause, Effect, Exit, Fiber, Queue, Stream } from 'effect'
import * as fc from 'fast-check'

interface PropertyRequest<A, E> {
  readonly value: A
  readonly reply: (exit: Exit.Exit<void, E>) => void
}

/** Even an interrupted case must release the Promise fast-check is waiting on before closing. */
const evaluate = <A, E, R>(
  property: (value: A) => Effect.Effect<void, E, R>,
  request: PropertyRequest<A, E>,
) =>
  Effect.suspend(() => property(request.value)).pipe(
    Effect.onExit((exit) => Effect.sync(() => request.reply(exit))),
    Effect.exit,
  )

/**
 * fast-check asks for Promises; the property must stay inside @effect/vitest's clock and scope.
 * A queue hands each generated value to the owning test fiber and answers only after its case
 * has finalized. Failed assertions go back to fast-check for shrinking and seed/path reporting.
 * No nested Effect runtime is needed, and interruption closes the producer with the test scope.
 */
export const checkSequences = Effect.fn('Test.checkSequences')(function* <A, E, R>(
  arbitrary: fc.Arbitrary<A>,
  property: (value: A) => Effect.Effect<void, E, R>,
  options: { readonly seed: number; readonly numRuns: number },
) {
  const requests = yield* Queue.unbounded<PropertyRequest<A, E>, Cause.Done>()
  // The callback only enqueues work; the test fiber owns its execution and finalization.
  const checkValue = (value: A) => {
    const answer = Promise.withResolvers<void>()
    const offered = Queue.offerUnsafe(requests, {
      value,
      reply: (exit) =>
        Exit.isSuccess(exit) ? answer.resolve() : answer.reject(Cause.squash(exit.cause)),
    })
    if (!offered) answer.reject(new Error('Property scope closed'))
    return answer.promise
  }
  const generated = yield* Effect.promise(() =>
    fc.assert(fc.asyncProperty(arbitrary, checkValue), options),
  ).pipe(Effect.ensuring(Queue.end(requests)), Effect.forkScoped)
  yield* Stream.fromQueue(requests).pipe(
    Stream.runForEach((request) => evaluate(property, request)),
  )
  yield* Fiber.join(generated)
})
