import { describe, expect, layer } from '@effect/vitest'
import { CreateWatchRequest, WatchId, WatchState } from '@vivid/contracts'
import { Clock, Effect, Fiber, Option, Queue, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ExecutorEventChanged, ExecutorEventRefused, ExecutorEventsUnreachable } from './events.ts'
import { RENEW_WITHIN_MS, TTL_MS, WatchEventUnknown, Watches } from './lifecycle.ts'
import { WatchStore } from './store.ts'
import { Executor, person, testLayer } from './testing.ts'

const HOUR = 60 * 60_000
const request = CreateWatchRequest.make({
  name: 'New mail in Work Mail',
  account: 'mail (work)',
  event: 'message.received',
  arguments: { folder: 'inbox' },
  instruction: 'Tell me when a client writes.',
})

/** The Watch id is the last segment of the callback Executor was asked to deliver to. */
const idOf = (url: string) => WatchId.make(url.slice(url.lastIndexOf('/') + 1))

/** Create a Watch and grant it, expiring `expiresIn` from now on the test clock. */
const granted = Effect.fn('WatchTest.granted')(function* (expiresIn: number, name: string) {
  const actor = yield* person()
  const executor = yield* Executor
  const now = yield* Clock.currentTimeMillis
  yield* Queue.offer(executor.answers, {
    id: `evs_${'0'.repeat(32)}`,
    refreshBefore: new Date(now + expiresIn),
  })
  const watch = yield* (yield* Watches).create(actor, { ...request, name })
  yield* Queue.take(executor.subscribed)
  return { actor, watch }
})

/** The stored state of a Watch now. */
const stateOf = Effect.fn('WatchTest.stateOf')(function* (id: WatchId) {
  const found = yield* (yield* WatchStore).find(id)
  return Option.map(found, (record) => record.watch.state)
})

describe.skipIf(!testDatabaseConfigured)('Watches', () => {
  layer(testLayer)((it) => {
    it.effect('stores the Watch Pending before asking Executor, then makes it Active', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        const creating = yield* Effect.forkChild((yield* Watches).create(actor, request))
        // Executor is now holding the subscribe call, as it does while it POSTs its challenge.
        const asked = yield* Queue.take(executor.subscribed)
        expect(asked.name).toBe('mail.message.received')
        expect(asked.arguments).toEqual({ folder: 'inbox' })
        expect(asked.url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/api\/watches\/[0-9a-f-]{36}$/u)
        const pending = yield* (yield* WatchStore).find(idOf(asked.url))
        expect(Option.map(pending, (record) => record.watch.state)).toEqual(
          Option.some(WatchState.cases.Pending.make({})),
        )
        yield* Queue.offer(executor.answers, {
          id: `evs_${'1'.repeat(32)}`,
          refreshBefore: new Date(TTL_MS),
        })
        const watch = yield* Fiber.join(creating)
        expect(watch.state).toEqual(WatchState.cases.Active.make({ refreshBefore: TTL_MS }))
        expect(watch.account).toBe('Mail (Work)')
        expect((yield* (yield* Watches).list(actor)).map((one) => one.name)).toEqual([request.name])
      }).pipe(Effect.scoped),
    )

    it.effect('removes the Pending Watch when Executor refuses, so its name is free again', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        yield* Queue.offer(executor.answers, new ExecutorEventRefused({}))
        const refused = yield* Effect.flip((yield* Watches).create(actor, request))
        expect(refused._tag).toBe('ExecutorEventRefused')
        const asked = yield* Queue.take(executor.subscribed)
        expect(yield* stateOf(idOf(asked.url))).toEqual(Option.none())
        expect(yield* (yield* Watches).list(actor)).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a second live Watch with the same name and an undeclared event', () =>
      Effect.gen(function* () {
        const { actor } = yield* granted(TTL_MS, request.name)
        const taken = yield* Effect.flip((yield* Watches).create(actor, request))
        expect(taken._tag).toBe('WatchNameTaken')
        const unknown = yield* Effect.flip(
          (yield* Watches).create(actor, { ...request, name: 'Other', event: 'thing' }),
        )
        if (!(unknown instanceof WatchEventUnknown))
          return expect.fail(`Refused as ${unknown._tag}`)
        expect(unknown.known).toEqual(['message.received'])
      }).pipe(Effect.scoped),
    )

    it.effect('stops by name: marked Stopped, unsubscribed, no longer listed', () =>
      Effect.gen(function* () {
        const { actor, watch } = yield* granted(TTL_MS, 'Stop me')
        const stopped = yield* (yield* Watches).stop(actor, 'Stop me')
        expect(stopped.state).toEqual(WatchState.cases.Stopped.make({ reason: 'removed' }))
        expect(yield* Ref.get((yield* Executor).unsubscribed)).toContain('mail.message.received')
        expect(yield* (yield* Watches).list(actor)).toEqual([])
        expect(yield* stateOf(watch.id)).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'removed' })),
        )
        const again = yield* Effect.flip((yield* Watches).stop(actor, 'Stop me'))
        expect(again._tag).toBe('WatchMissing')
      }).pipe(Effect.scoped),
    )

    it.effect('renews a Watch near expiry and moves it by what Executor answers', () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const watching = yield* Watches
        const renewed = yield* granted(HOUR, 'Renewed')
        const later = yield* granted(RENEW_WITHIN_MS + HOUR, 'Not due yet')
        // Due: renewed with a fresh week. Not due: left alone, so no answer is consumed for it.
        yield* Queue.offer(executor.answers, {
          id: `evs_${'2'.repeat(32)}`,
          refreshBefore: new Date(TTL_MS),
        })
        yield* watching.renew()
        expect(yield* stateOf(renewed.watch.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: TTL_MS })),
        )
        expect(yield* stateOf(later.watch.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: RENEW_WITHIN_MS + HOUR })),
        )
        yield* watching.stop(renewed.actor, 'Renewed')
        yield* watching.stop(later.actor, 'Not due yet')
      }).pipe(Effect.scoped),
    )

    it.effect('stops a Watch whose event changed or was refused; keeps one Executor missed', () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const watching = yield* Watches
        const changed = yield* granted(HOUR, 'Changed')
        yield* Queue.offer(executor.answers, new ExecutorEventChanged({}))
        yield* watching.renew()
        expect(yield* stateOf(changed.watch.id)).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'changed' })),
        )
        const refused = yield* granted(HOUR, 'Refused')
        yield* Queue.offer(executor.answers, new ExecutorEventRefused({}))
        yield* watching.renew()
        expect(yield* stateOf(refused.watch.id)).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'refused' })),
        )
        const missed = yield* granted(HOUR, 'Missed')
        yield* Queue.offer(executor.answers, new ExecutorEventsUnreachable({}))
        yield* watching.renew()
        expect(yield* stateOf(missed.watch.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: HOUR })),
        )
        // Once the subscription has expired, a renewal that still does not get through ends it.
        yield* TestClock.adjust(HOUR)
        yield* Queue.offer(executor.answers, new ExecutorEventsUnreachable({}))
        yield* watching.renew()
        expect(yield* stateOf(missed.watch.id)).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'unreachable' })),
        )
      }).pipe(Effect.scoped),
    )
  })
})
