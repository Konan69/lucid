import { expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { Changes, Topic } from './changes.ts'
import { watch } from './query.ts'
import { LiveTally, makeTally } from './tally.ts'
import { PersonId } from '@vivid/contracts'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'

/** A bus held in memory, so a test moves a topic by hand and nothing else can. */
const busLayer = Layer.effect(
  Changes,
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<void>()
    return Changes.of({
      publish: () => PubSub.publish(hub, undefined).pipe(Effect.asVoid),
      subscribe: () => Effect.map(PubSub.subscribe(hub), (taken) => Stream.fromSubscription(taken)),
    })
  }),
)

const ada = Topic.person(PersonId.make('ada'))

layer(busLayer)('live query counts', (it) => {
  it.effect('counts a load that answers, an answer that is sent, and one that is the same', () =>
    Effect.gen(function* () {
      const tally = makeTally()
      const changes = yield* Changes
      let answer = 1
      const loaded = yield* Queue.unbounded<void>()
      const load = Effect.as(
        Queue.offer(loaded, undefined),
        Effect.sync(() => answer),
      ).pipe(Effect.flatten)
      const seen = yield* Queue.unbounded<number>()
      const fiber = yield* watch('WatchThreads', [ada], load).pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.provideService(LiveTally, tally),
        Effect.forkScoped,
      )
      expect(yield* Queue.take(seen)).toBe(1)
      yield* Queue.take(loaded)
      // The same answer again: loaded, not sent. Nothing arrives, so the load itself is the signal.
      yield* changes.publish([ada])
      yield* TestClock.adjust('20 millis')
      yield* Queue.take(loaded)
      // A different answer: loaded and sent. Its arrival also proves the load before it finished.
      answer = 2
      yield* changes.publish([ada])
      yield* TestClock.adjust('20 millis')
      expect(yield* Queue.take(seen)).toBe(2)
      expect(tally.drain().queries).toEqual([
        [
          'WatchThreads',
          {
            open: 1,
            loads: 3,
            sent: 2,
            interrupted: 0,
            failed: 0,
            loadMillis: 0,
            slowestMillis: 0,
          },
        ],
      ])
      // Nothing happened since: the open subscription is kept and no line is due.
      expect(tally.drain().queries).toEqual([])
      yield* Fiber.interrupt(fiber)
      yield* changes.publish([ada])
      expect(tally.drain().queries).toEqual([])
    }),
  )

  it.effect('counts a load a newer change overtook, with the time the one that answered took', () =>
    Effect.gen(function* () {
      const tally = makeTally()
      const changes = yield* Changes
      const load = Effect.as(Effect.sleep('50 millis'), 'answer')
      const seen = yield* Queue.unbounded<string>()
      const started = yield* Queue.unbounded<void>()
      yield* watch('WatchInbox', [ada], Effect.andThen(Queue.offer(started, undefined), load)).pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.provideService(LiveTally, tally),
        Effect.forkScoped,
      )
      yield* Queue.take(started)
      // Arrives while the first load is still asleep, and replaces it.
      yield* changes.publish([ada])
      yield* TestClock.adjust('20 millis')
      yield* Queue.take(started)
      yield* TestClock.adjust('50 millis')
      expect(yield* Queue.take(seen)).toBe('answer')
      expect(tally.drain().queries).toEqual([
        [
          'WatchInbox',
          {
            open: 1,
            loads: 1,
            sent: 1,
            interrupted: 1,
            failed: 0,
            loadMillis: 50,
            slowestMillis: 50,
          },
        ],
      ])
    }),
  )

  it.effect('counts a load that failed', () =>
    Effect.gen(function* () {
      const tally = makeTally()
      yield* watch('WatchRules', [ada], Effect.fail('refused')).pipe(
        Stream.runDrain,
        Effect.provideService(LiveTally, tally),
        Effect.exit,
      )
      expect(tally.drain().queries).toEqual([
        [
          'WatchRules',
          {
            open: 0,
            loads: 0,
            sent: 0,
            interrupted: 0,
            failed: 1,
            loadMillis: 0,
            slowestMillis: 0,
          },
        ],
      ])
    }),
  )
})
