import { describe, expect, it, vi } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import { Forbidden, RuntimeUnavailable, ThreadId } from '@vivid/contracts'
import { Clock, Deferred, Effect, Layer, Queue, Ref, Result, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as TestClock from 'effect/testing/TestClock'
import { LiveState, liveStateOf, makeLive, type ProductFailure } from './live.js'

/** Provides a controlled RPC write and shares the test clock with the atom runtime. */
const testClientLayer = (markPlans: Queue.Queue<Effect.Effect<void, ProductFailure>>) =>
  TestClock.testClockWith((clock) =>
    Effect.succeed(
      Layer.provide(
        Layer.mock(VividRpcClient, {
          MarkThreadRead: () => Queue.take(markPlans).pipe(Effect.flatten),
        }),
        Layer.succeed(Clock.Clock, clock),
      ),
    ),
  )

/** Builds a queue-backed query whose consumer can assert loading before the first server event. */
const queuedQuery = Effect.fn('LiveTest.queuedQuery')(function* () {
  const values = yield* Queue.unbounded<number>()
  const received = yield* Queue.unbounded<number>()
  const plans = yield* Queue.unbounded<Effect.Effect<void, ProductFailure>>()
  const live = makeLive(yield* testClientLayer(plans))
  const query = live.query((_client) =>
    Stream.fromQueue(values).pipe(
      Stream.take(2),
      Stream.tap((value) => Queue.offer(received, value)),
    ),
  )
  return { live, query, values, received, plans }
})

describe('live state', () => {
  it.effect('shows Loading before the first event and Ready after a stream value', () =>
    Effect.gen(function* () {
      const test = yield* queuedQuery()
      const unsubscribe = test.live.registry.subscribe(test.query.atom, () => {})
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(LiveState.Loading())

      yield* Queue.offer(test.values, 41)
      expect(yield* Queue.take(test.received)).toBe(41)
      yield* TestClock.adjust(0)
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(
        LiveState.Ready({ value: 41 }),
      )
      unsubscribe()
    }),
  )

  it.effect('ends on a final failure without reopening the stream', () =>
    Effect.gen(function* () {
      const plans = yield* Queue.unbounded<Effect.Effect<void, ProductFailure>>()
      const opens = yield* Ref.make(0)
      const live = makeLive(yield* testClientLayer(plans))
      const query = live.query(() =>
        Stream.unwrap(
          Ref.updateAndGet(opens, (count) => count + 1).pipe(
            Effect.as(Stream.fail(Forbidden.make({ message: 'No access' }))),
          ),
        ),
      )
      const unsubscribe = live.registry.subscribe(query.atom, () => {})
      live.registry.get(query.atom)
      yield* TestClock.adjust(0)

      expect(liveStateOf(live.registry.get(query.atom))).toEqual(
        LiveState.Failed({ failure: Forbidden.make({ message: 'No access' }) }),
      )
      yield* TestClock.adjust('1500 millis')
      expect(yield* Ref.get(opens)).toBe(1)
      unsubscribe()
    }),
  )

  it.effect('reopens after a transient failure and recovers on the scheduled retry', () =>
    Effect.gen(function* () {
      const plans = yield* Queue.unbounded<Effect.Effect<void, ProductFailure>>()
      const opens = yield* Ref.make(0)
      const failed = yield* Deferred.make<void>()
      const recovered = yield* Deferred.make<void>()
      const live = makeLive(yield* testClientLayer(plans))
      const query = live.query(() =>
        Stream.unwrap(
          Ref.modify(opens, (count) => [count + 1, count + 1] as const).pipe(
            Effect.map((attempt) =>
              attempt === 1
                ? Stream.fail(RuntimeUnavailable.make({ message: 'Offline' })).pipe(
                    Stream.ensuring(Deferred.succeed(failed, undefined)),
                  )
                : Stream.succeed(73).pipe(
                    Stream.ensuring(Deferred.succeed(recovered, undefined)),
                  ),
            ),
          ),
        ),
      )
      const unsubscribe = live.registry.subscribe(query.atom, () => {})
      live.registry.get(query.atom)
      yield* TestClock.adjust(0)
      expect(yield* Ref.get(opens)).toBe(1)
      yield* Deferred.await(failed)
      yield* TestClock.adjust(0)

      yield* TestClock.adjust('1499 millis')
      expect(yield* Ref.get(opens)).toBe(1)
      yield* TestClock.adjust('1 millis')
      yield* Deferred.await(recovered)
      yield* TestClock.adjust(0)
      expect(yield* Ref.get(opens)).toBe(2)
      expect(liveStateOf(live.registry.get(query.atom))).toEqual(LiveState.Ready({ value: 73 }))
      unsubscribe()
    }),
  )

  it.effect('shows an expected change and rolls it back, but retains it after a later server event', () =>
    Effect.gen(function* () {
      const test = yield* queuedQuery()
      const unsubscribe = test.live.registry.subscribe(test.query.atom, () => {})
      test.live.registry.get(test.query.atom)
      yield* Queue.offer(test.values, 10)
      expect(yield* Queue.take(test.received)).toBe(10)
      yield* TestClock.adjust(0)
      yield* Queue.offer(test.plans, Effect.fail(Forbidden.make({ message: 'Refused' })))
      yield* Queue.offer(test.plans, Effect.succeed(undefined))

      const refused = test.live.change(
        (client) => client.MarkThreadRead({ id: ThreadId.make('thread-test') }),
        () => test.query.expect(() => 20),
      )
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(
        LiveState.Ready({ value: 20 }),
      )
      yield* Effect.promise(() => refused)
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(
        LiveState.Ready({ value: 10 }),
      )

      const accepted = test.live.change(
        (client) => client.MarkThreadRead({ id: ThreadId.make('thread-test') }),
        () => test.query.expect(() => 20),
      )
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(
        LiveState.Ready({ value: 20 }),
      )
      yield* Effect.promise(() => accepted)
      yield* Queue.offer(test.values, 30)
      expect(yield* Queue.take(test.received)).toBe(30)
      yield* TestClock.adjust(0)
      expect(liveStateOf(test.live.registry.get(test.query.atom))).toEqual(
        LiveState.Ready({ value: 20 }),
      )
      unsubscribe()
    }),
  )

  it.effect('returns Result values from run for both success and failure', () =>
    Effect.gen(function* () {
      const plans = yield* Queue.unbounded<Effect.Effect<void, ProductFailure>>()
      const live = makeLive(yield* testClientLayer(plans))
      const success = yield* Effect.promise(() => live.run(Effect.succeed('done')))
      const failure = yield* Effect.promise(() =>
        live.run(Effect.fail(Forbidden.make({ message: 'Denied' }))),
      )

      expect(Result.isSuccess(success)).toBe(true)
      if (Result.isSuccess(success)) expect(success.success).toBe('done')
      expect(Result.isFailure(failure)).toBe(true)
      if (Result.isFailure(failure))
        expect(failure.failure).toEqual(Forbidden.make({ message: 'Denied' }))
    }),
  )

  it.effect('debounces new ask arguments and retains the last answer while pending', () => {
    const program = Effect.fn('LiveTest.ask')(function* () {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const plans = yield* Queue.unbounded<Effect.Effect<void, ProductFailure>>()
      const argumentsAtom = Atom.make('first')
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const pending = yield* Deferred.make<string>()
      const live = makeLive(yield* testClientLayer(plans))
      const answer = live.ask(argumentsAtom, (_client, argument) =>
        Ref.update(asked, (values) => [...values, argument]).pipe(
          Effect.flatMap(() => argument === 'next' ? Deferred.await(pending) : Effect.succeed('FIRST')),
        ),
      )
      const unsubscribe = live.registry.subscribe(answer, () => {})
      live.registry.get(answer)
      yield* TestClock.adjust(0)
      yield* TestClock.adjust('120 millis')
      vi.advanceTimersByTime(120)
      yield* TestClock.adjust(0)
      expect(yield* Ref.get(asked)).toEqual(['first'])
      expect(liveStateOf(live.registry.get(answer))).toEqual(LiveState.Ready({ value: 'FIRST' }))

      yield* Ref.set(asked, [])
      live.registry.set(argumentsAtom, 'next')
      yield* TestClock.adjust(0)
      yield* TestClock.adjust('119 millis')
      vi.advanceTimersByTime(119)
      yield* TestClock.adjust(0)
      expect(yield* Ref.get(asked)).toEqual([])
      expect(liveStateOf(live.registry.get(answer))).toEqual(LiveState.Ready({ value: 'FIRST' }))
      yield* TestClock.adjust('1 millis')
      vi.advanceTimersByTime(1)
      yield* TestClock.adjust(0)
      expect(yield* Ref.get(asked)).toEqual(['next'])
      expect(liveStateOf(live.registry.get(answer))).toEqual(LiveState.Ready({ value: 'FIRST' }))
      yield* Deferred.succeed(pending, 'NEXT')
      yield* TestClock.adjust(0)
      expect(liveStateOf(live.registry.get(answer))).toEqual(LiveState.Ready({ value: 'NEXT' }))
      unsubscribe()
    })()
    return program.pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())))
  })
})
