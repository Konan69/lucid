import { expect, it } from '@effect/vitest'
import { ServiceAuthorization, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Queue, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { retainCatalog } from './catalog.ts'
import { ExecutorServiceEntry } from './executor.ts'

/** Deferred remote attempts control completion without mocking the retained-snapshot seam. */
const source = Effect.fn('CatalogTest.source')(function* () {
  const plans =
    yield* Queue.unbounded<
      Effect.Effect<readonly (typeof ExecutorServiceEntry.Type)[], ServiceUnavailable>
    >()
  const calls = yield* Ref.make(0)
  const load = Effect.fn('CatalogTest.load')(function* () {
    yield* Ref.update(calls, (count) => count + 1)
    const plan = yield* Queue.take(plans)
    return yield* plan
  })
  const catalog = yield* retainCatalog(load())
  return { plans, calls, catalog }
})

/** Catalog values change between remote attempts so the observable snapshot identifies a refresh. */
const entry = (name: string) =>
  ExecutorServiceEntry.make({
    id: ServiceId.make(name),
    name,
    description: name,
    domain: null,
    authorization: ServiceAuthorization.cases.None.make({}),
  })
const unavailable = ServiceUnavailable.make({ service: 'connections', message: 'Unavailable' })

it.effect(
  'shares one cold download and serves retained data throughout refresh failure and recovery',
  () =>
    Effect.gen(function* () {
      const remote = yield* source()
      const initial = yield* Deferred.make<
        readonly (typeof ExecutorServiceEntry.Type)[],
        ServiceUnavailable
      >()
      yield* Queue.offer(remote.plans, Deferred.await(initial))
      const readers = yield* Effect.all([remote.catalog(), remote.catalog()], {
        concurrency: 'unbounded',
      }).pipe(Effect.forkChild)
      yield* Deferred.succeed(initial, [entry('First')])
      expect(yield* Fiber.join(readers)).toEqual([[entry('First')], [entry('First')]])
      expect(yield* Ref.get(remote.calls)).toBe(1)

      const refresh = yield* Deferred.make<
        readonly (typeof ExecutorServiceEntry.Type)[],
        ServiceUnavailable
      >()
      yield* Queue.offer(remote.plans, Deferred.await(refresh))
      yield* TestClock.adjust('10 minutes')
      expect(yield* remote.catalog()).toEqual([entry('First')])
      expect(yield* Ref.get(remote.calls)).toBe(2)
      yield* Deferred.fail(refresh, unavailable)
      yield* Queue.offer(remote.plans, Effect.succeed([entry('Later')]))
      yield* TestClock.adjust('29 seconds')
      expect(yield* remote.catalog()).toEqual([entry('First')])
      expect(yield* Ref.get(remote.calls)).toBe(2)
      yield* TestClock.adjust('1 second')
      expect(yield* remote.catalog()).toEqual([entry('Later')])
      expect(yield* Ref.get(remote.calls)).toBe(3)
      yield* Queue.offer(remote.plans, Effect.succeed([entry('Latest')]))
      yield* TestClock.adjust('10 minutes')
      expect(yield* remote.catalog()).toEqual([entry('Latest')])
    }).pipe(Effect.scoped),
)

it.effect('fails cold readers honestly and retries once after thirty seconds', () =>
  Effect.gen(function* () {
    const remote = yield* source()
    yield* Queue.offer(remote.plans, Effect.fail(unavailable))
    expect(yield* remote.catalog().pipe(Effect.flip)).toBeInstanceOf(ServiceUnavailable)
    expect(yield* remote.catalog().pipe(Effect.flip)).toBeInstanceOf(ServiceUnavailable)
    expect(yield* Ref.get(remote.calls)).toBe(1)
    yield* Queue.offer(remote.plans, Effect.succeed([entry('Recovered')]))
    yield* TestClock.adjust('30 seconds')
    expect(yield* remote.catalog()).toEqual([entry('Recovered')])
    expect(yield* Ref.get(remote.calls)).toBe(2)
  }).pipe(Effect.scoped),
)
