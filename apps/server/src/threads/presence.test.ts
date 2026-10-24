import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect, Layer, Queue, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, changesLayer, everyPart, Topic } from '../live/changes.ts'
import { fixture } from '../push/testing.ts'
import { Link } from '../rpc/link.ts'
import { Presence, presenceLayer } from './presence.ts'

const services = presenceLayer.pipe(
  Layer.provideMerge(changesLayer),
  Layer.provideMerge(testDatabaseLayer),
)

/** Observe actual PostgreSQL invalidations, so presence expiry must wake the same path as a live client. */
describe.skipIf(!testDatabaseConfigured)('presence connection signals', () => {
  it.effect('announces socket closure immediately without advancing the sweep clock', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(services)
      return yield* Effect.gen(function* () {
        const owner = yield* fixture()
        const changes = yield* Changes
        const notices = yield* Queue.unbounded<void>()
        const moved = yield* changes.subscribe([Topic.thread(owner.threadId)], everyPart)
        yield* moved.pipe(
          Stream.runForEach(() => Queue.offer(notices, undefined)),
          Effect.forkScoped,
        )
        const presence = yield* Presence
        const link = new Link(yield* Clock.currentTimeMillis)
        yield* presence.hold(
          owner.threadId,
          {
            id: owner.person.id,
            name: owner.person.name,
            image: null,
          },
          false,
          link,
        )
        yield* Queue.take(notices)
        expect(yield* presence.here(owner.threadId)).toHaveLength(1)
        link.close()
        yield* Queue.take(notices)
        expect(yield* presence.here(owner.threadId)).toEqual([])
        // A late frame cannot resurrect the closed connection.
        link.heard(yield* Clock.currentTimeMillis)
        yield* TestClock.adjust('15 seconds')
        expect(yield* presence.here(owner.threadId)).toEqual([])
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped),
  )
})
