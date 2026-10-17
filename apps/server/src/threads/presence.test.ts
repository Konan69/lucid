import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { Changes, Topic } from '../live/changes.ts'
import { Link } from '../rpc/link.ts'
import { Presence, presenceLayer } from './presence.ts'

const thread = ThreadId.make('5b0d4c1e-8f43-4d2c-9a57-0c6f1e2d3a4b')
const ada = { id: PersonId.make('ada'), name: 'Ada', image: null }

/** A presence of its own, with every change it announces kept in the order it was announced. */
const presenceWithBus = Effect.fn('PresenceTest.withBus')(function* () {
  const told = yield* Queue.unbounded<ReadonlyArray<Topic>>()
  const changes = Changes.of({
    publish: (topics) => Queue.offer(told, topics).pipe(Effect.asVoid),
    subscribe: () => Effect.succeed(Stream.empty),
  })
  const context = yield* Layer.build(
    presenceLayer.pipe(Layer.provide(Layer.succeed(Changes, changes))),
  )
  return { presence: Context.get(context, Presence), told }
})

/** A hold as one call keeps it: open until its scope is closed. */
const holding = (presence: Presence['Service'], typing: boolean, link: Link) =>
  Effect.gen(function* () {
    const call = yield* Scope.make()
    yield* presence.hold(thread, ada, typing, link).pipe(Scope.provide(call))
    return call
  })

describe('presence held by an open call', () => {
  it.effect(
    'shows a Person from the moment they hold it and stops a second after they let go',
    () =>
      Effect.gen(function* () {
        const { presence, told } = yield* presenceWithBus()
        const call = yield* holding(presence, false, new Link(0))
        expect(yield* Queue.take(told)).toEqual([Topic.thread(thread)])
        expect(yield* presence.here(thread)).toEqual([{ person: ada, typing: false }])
        expect(yield* presence.present(ada.id)).toBe(true)

        yield* Scope.close(call, Exit.void)
        // Still there for the moment a client takes to open its next hold.
        expect(yield* presence.watching(thread, ada.id)).toBe(true)
        yield* TestClock.adjust('1 second')
        expect(yield* Queue.take(told)).toEqual([Topic.thread(thread)])
        expect(yield* presence.here(thread)).toEqual([])
        expect(yield* presence.present(ada.id)).toBe(false)
      }),
  )

  it.effect('changes what is typed without the Person leaving in between', () =>
    Effect.gen(function* () {
      const { presence, told } = yield* presenceWithBus()
      const link = new Link(0)
      const reading = yield* holding(presence, false, link)
      yield* Queue.take(told)

      // A client that starts typing closes its hold and opens one that says so.
      yield* Scope.close(reading, Exit.void)
      const writing = yield* holding(presence, true, link)
      expect(yield* Queue.take(told)).toEqual([Topic.thread(thread)])
      expect(yield* presence.here(thread)).toEqual([{ person: ada, typing: true }])

      yield* TestClock.adjust('1 second')
      expect(yield* presence.here(thread)).toEqual([{ person: ada, typing: true }])
      expect(yield* Queue.size(told)).toBe(0)
      yield* Scope.close(writing, Exit.void)
    }),
  )

  it.effect('drops a Person whose link went quiet, and shows them again when it is heard', () =>
    Effect.gen(function* () {
      const { presence, told } = yield* presenceWithBus()
      const link = new Link(0)
      yield* holding(presence, false, link)
      yield* Queue.take(told)

      yield* TestClock.adjust('10 seconds')
      expect(yield* presence.present(ada.id)).toBe(true)
      yield* TestClock.adjust('5 seconds')
      expect(yield* Queue.take(told)).toEqual([Topic.thread(thread)])
      expect(yield* presence.here(thread)).toEqual([])
      expect(yield* presence.watching(thread, ada.id)).toBe(false)
      expect(yield* presence.present(ada.id)).toBe(false)

      link.heard(15_000)
      yield* TestClock.adjust('5 seconds')
      expect(yield* Queue.take(told)).toEqual([Topic.thread(thread)])
      expect(yield* presence.here(thread)).toEqual([{ person: ada, typing: false }])
    }),
  )

  it.effect('drops a Person the moment their socket closes', () =>
    Effect.gen(function* () {
      const { presence, told } = yield* presenceWithBus()
      const link = new Link(0)
      yield* holding(presence, false, link)
      yield* Queue.take(told)
      link.close()
      expect(yield* presence.present(ada.id)).toBe(false)
    }),
  )
})
