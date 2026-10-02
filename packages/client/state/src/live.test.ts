import { describe, expect, it, vi } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import { Forbidden, RuntimeUnavailable, SkillReadOnly, ThreadId } from '@vivid/contracts'
import { Clock, Deferred, Effect, Fiber, Layer, Queue, Ref, Result, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as TestClock from 'effect/testing/TestClock'
import { LiveState, liveStateOf, makeLive, type ProductFailure } from './live.js'

type MarkThreadReadFailure = Exclude<ProductFailure, SkillReadOnly>

/** Provides a controlled RPC write and shares the test clock with the atom runtime. */
const testClientLayer = (markPlans: Queue.Queue<Effect.Effect<void, MarkThreadReadFailure>>) =>
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
  const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
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

  it.effect('shows every result the server sends, not only the first', () =>
    Effect.gen(function* () {
      const values = yield* Queue.unbounded<number>()
      const received = yield* Queue.unbounded<number>()
      const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
      const live = makeLive(yield* testClientLayer(plans))
      const query = live.query(() =>
        Stream.fromQueue(values).pipe(Stream.tap((value) => Queue.offer(received, value))),
      )
      const unsubscribe = live.registry.subscribe(query.atom, () => {})
      live.registry.get(query.atom)
      // A stream that stays open marks each of its results as still waiting for more. A view that
      // only took settled results showed the first one for ever.
      for (const value of [1, 2, 3]) {
        yield* Queue.offer(values, value)
        expect(yield* Queue.take(received)).toBe(value)
        yield* TestClock.adjust(0)
        expect(liveStateOf(live.registry.get(query.atom))).toEqual(LiveState.Ready({ value }))
      }
      unsubscribe()
    }),
  )

  it.effect('ends on a final failure without reopening the stream', () =>
    Effect.gen(function* () {
      const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
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
      const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
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
                : Stream.succeed(73).pipe(Stream.ensuring(Deferred.succeed(recovered, undefined))),
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

  it.effect(
    'shows an expected change at once, takes it back on refusal, and yields to the server',
    () =>
      Effect.gen(function* () {
        const test = yield* queuedQuery()
        const unsubscribe = test.live.registry.subscribe(test.query.atom, () => {})
        test.live.registry.get(test.query.atom)
        yield* Queue.offer(test.values, 10)
        expect(yield* Queue.take(test.received)).toBe(10)
        yield* TestClock.adjust(0)
        // Each call waits on its own gate, so the moment between sending and hearing back can be
        // looked at: that is when the expected value must already be on screen.
        const refusal = yield* Deferred.make<void, MarkThreadReadFailure>()
        const acceptance = yield* Deferred.make<void, MarkThreadReadFailure>()
        yield* Queue.offer(test.plans, Deferred.await(refusal))
        yield* Queue.offer(test.plans, Deferred.await(acceptance))
        const shown = () => liveStateOf(test.live.registry.get(test.query.atom))

        const refused = yield* Effect.forkChild(
          test.live.change(
            (client) => client.MarkThreadRead({ id: ThreadId.make('thread-test') }),
            () => test.query.expect(() => 20),
          ),
        )
        yield* TestClock.adjust(0)
        expect(shown()).toEqual(LiveState.Ready({ value: 20 }))
        yield* Deferred.fail(refusal, Forbidden.make({ message: 'Refused' }))
        expect(Result.isFailure(yield* Fiber.join(refused))).toBe(true)
        expect(shown()).toEqual(LiveState.Ready({ value: 10 }))

        const accepted = yield* Effect.forkChild(
          test.live.change(
            (client) => client.MarkThreadRead({ id: ThreadId.make('thread-test') }),
            () => test.query.expect(() => 20),
          ),
        )
        yield* TestClock.adjust(0)
        expect(shown()).toEqual(LiveState.Ready({ value: 20 }))
        yield* Deferred.succeed(acceptance, undefined)
        expect(Result.isSuccess(yield* Fiber.join(accepted))).toBe(true)
        // An accepted change reopens the subscription. Let the old one finish closing first, or it
        // is still first in line at the queue and swallows the next value.
        yield* TestClock.adjust(0)
        // What the server says next is the truth, whatever was expected.
        yield* Queue.offer(test.values, 30)
        expect(yield* Queue.take(test.received)).toBe(30)
        yield* TestClock.adjust(0)
        expect(shown()).toEqual(LiveState.Ready({ value: 30 }))
        unsubscribe()
      }),
  )

  it.effect('returns Result values from run for both success and failure', () =>
    Effect.gen(function* () {
      const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
      const live = makeLive(yield* testClientLayer(plans))
      const success = yield* live.run(Effect.succeed('done'))
      const failure = yield* live.run(Effect.fail(Forbidden.make({ message: 'Denied' })))

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
      const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
      const argumentsAtom = Atom.make('first')
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const pending = yield* Deferred.make<string>()
      const live = makeLive(yield* testClientLayer(plans))
      const answer = live.ask(argumentsAtom, (_client, argument) =>
        Ref.update(asked, (values) => [...values, argument]).pipe(
          Effect.flatMap(() =>
            argument === 'next' ? Deferred.await(pending) : Effect.succeed('FIRST'),
          ),
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

  it.effect(
    'beats on mount, every interval and at once when what it says changes, then stops',
    () => {
      const program = Effect.fn('LiveTest.beat')(function* () {
        // The atom runtime waits on real timers, so the test holds those, as the search test does.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const plans = yield* Queue.unbounded<Effect.Effect<void, MarkThreadReadFailure>>()
        const said = yield* Queue.unbounded<boolean>()
        const typing = Atom.make(false)
        const live = makeLive(yield* testClientLayer(plans))
        const here = live.beat(typing, (_client, value) => Queue.offer(said, value), '5 seconds')
        // Mounted the way a screen mounts it: read at once, kept while the screen is open.
        const unmount = live.registry.mount(here)

        expect(yield* Queue.take(said)).toBe(false)
        yield* TestClock.adjust(0)
        vi.advanceTimersByTime(4999)
        yield* TestClock.adjust(0)
        expect(yield* Queue.size(said)).toBe(0)
        vi.advanceTimersByTime(1)
        expect(yield* Queue.take(said)).toBe(false)

        live.registry.set(typing, true)
        expect(yield* Queue.take(said)).toBe(true)

        unmount()
        yield* TestClock.adjust(0)
        vi.advanceTimersByTime(30_000)
        yield* TestClock.adjust(0)
        expect(yield* Queue.size(said)).toBe(0)
      })()
      return program.pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())))
    },
  )
})
