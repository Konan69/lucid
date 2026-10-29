import { describe, expect, layer } from '@effect/vitest'
import {
  CreateWatchRequest,
  WatchCondition,
  WatchIntent,
  WatchId,
  WatchState,
} from '@vivid/contracts'
import { Clock, Effect, Fiber, Option, Queue, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  ExecutorCallbackFailed,
  ExecutorEventChanged,
  ExecutorEventRefused,
  ExecutorEventsUnreachable,
} from './events.ts'
import {
  RECOVER_AFTER_MS,
  RENEW_WITHIN_MS,
  TTL_MS,
  WatchEventUnknown,
  Watches,
} from './lifecycle.ts'
import { WatchStore } from './store.ts'
import { Executor, person, testLayer } from './testing.ts'

const HOUR = 60 * 60_000
const request = CreateWatchRequest.make({
  name: 'New mail in Work Mail',
  account: 'mail (work)',
  event: 'message.received',
  arguments: { folder: 'inbox' },
  instruction: 'Tell me when a client writes.',
  condition: WatchCondition.cases.Continuous.make({}),
  purpose: WatchIntent.cases.Event.make({}),
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
        yield* watching.stop(missed.actor, 'Missed')
      }).pipe(Effect.scoped),
    )

    it.effect('keeps an expired Watch through an outage and renews it once Executor answers', () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const watching = yield* Watches
        const lapsed = yield* granted(HOUR, 'Through an outage')
        // The stand-in is the file's: forget calls earlier tests left unread.
        yield* Queue.clear(executor.subscribed)
        // The outage outlasts the subscription: every pass after expiry still fails.
        yield* TestClock.adjust(2 * HOUR)
        yield* Queue.offer(executor.answers, new ExecutorEventsUnreachable({}))
        yield* watching.renew()
        yield* Queue.offer(executor.answers, new ExecutorCallbackFailed({ reason: 'timeout' }))
        yield* watching.renew()
        expect(yield* stateOf(lapsed.watch.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: HOUR })),
        )
        // Executor is back: the same key subscribes the expired Watch again for a fresh week.
        const now = yield* Clock.currentTimeMillis
        yield* Queue.offer(executor.answers, {
          id: `evs_${'3'.repeat(32)}`,
          refreshBefore: new Date(now + TTL_MS),
        })
        yield* watching.renew()
        expect(yield* stateOf(lapsed.watch.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: now + TTL_MS })),
        )
        // Each of the three passes asked with the key the Watch was created with.
        const keys = yield* Queue.takeAll(executor.subscribed)
        expect(keys.map((key) => key.url)).toEqual(
          Array.from({ length: 3 }, () => `http://127.0.0.1:8787/api/watches/${lapsed.watch.id}`),
        )
        yield* watching.stop(lapsed.actor, 'Through an outage')
      }).pipe(Effect.scoped),
    )

    it.effect('returns a Watch starting when Executor did not answer, and finishes it later', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        const watching = yield* Watches
        yield* Queue.clear(executor.subscribed)
        yield* Queue.offer(executor.answers, new ExecutorEventsUnreachable({}))
        const starting = yield* watching.create(actor, request)
        expect(starting.state).toEqual(WatchState.cases.Pending.make({}))
        expect((yield* watching.list(actor)).map((one) => one.name)).toEqual([request.name])
        const first = yield* Queue.take(executor.subscribed)
        // A pass inside the creation's own window leaves the row to it.
        yield* watching.renew()
        expect(yield* Queue.size(executor.subscribed)).toBe(0)
        yield* TestClock.adjust(RECOVER_AFTER_MS + 1)
        yield* Queue.offer(executor.answers, {
          id: `evs_${'4'.repeat(32)}`,
          refreshBefore: new Date(TTL_MS),
        })
        yield* watching.renew()
        expect(yield* Queue.take(executor.subscribed)).toEqual(first)
        expect(yield* stateOf(starting.id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: TTL_MS })),
        )
      }).pipe(Effect.scoped),
    )

    it.effect('recovers a creation interrupted while Executor was subscribing', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        const watching = yield* Watches
        yield* Queue.clear(executor.subscribed)
        const creating = yield* Effect.forkChild(watching.create(actor, request))
        const first = yield* Queue.take(executor.subscribed)
        // The request ends before Executor answers; nothing granted, the row stays Pending.
        yield* Fiber.interrupt(creating)
        const id = idOf(first.url)
        expect(yield* stateOf(id)).toEqual(Option.some(WatchState.cases.Pending.make({})))
        yield* TestClock.adjust(RECOVER_AFTER_MS + 1)
        yield* Queue.offer(executor.answers, {
          id: `evs_${'5'.repeat(32)}`,
          refreshBefore: new Date(TTL_MS),
        })
        yield* watching.renew()
        expect(yield* Queue.take(executor.subscribed)).toEqual(first)
        expect(yield* stateOf(id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: TTL_MS })),
        )
      }).pipe(Effect.scoped),
    )

    it.effect('recovers a grant lost before activation as the same subscription', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        const watching = yield* Watches
        yield* Queue.clear(executor.subscribed)
        const subscription = `evs_${'6'.repeat(32)}`
        yield* Queue.offer(executor.answers, {
          lost: { id: subscription, refreshBefore: new Date(TTL_MS) },
        })
        const creating = yield* Effect.forkChild(watching.create(actor, request))
        const first = yield* Queue.take(executor.subscribed)
        // Executor has subscribed; Vivid dies before it records the grant.
        expect(yield* Queue.take(executor.lost)).toBe(subscription)
        yield* Fiber.interrupt(creating)
        const id = idOf(first.url)
        expect(yield* stateOf(id)).toEqual(Option.some(WatchState.cases.Pending.make({})))
        // The same key at Executor is the same subscription: it answers the same id.
        yield* TestClock.adjust(RECOVER_AFTER_MS + 1)
        yield* Queue.offer(executor.answers, { id: subscription, refreshBefore: new Date(TTL_MS) })
        yield* watching.renew()
        expect(yield* Queue.take(executor.subscribed)).toEqual(first)
        expect(yield* stateOf(id)).toEqual(
          Option.some(WatchState.cases.Active.make({ refreshBefore: TTL_MS })),
        )
      }).pipe(Effect.scoped),
    )

    it.effect('stops a left-behind Watch Executor refuses, and drops one refused at creation', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const executor = yield* Executor
        const watching = yield* Watches
        yield* Queue.clear(executor.subscribed)
        const creating = yield* Effect.forkChild(watching.create(actor, request))
        const first = yield* Queue.take(executor.subscribed)
        yield* Fiber.interrupt(creating)
        yield* TestClock.adjust(RECOVER_AFTER_MS + 1)
        yield* Queue.offer(executor.answers, new ExecutorEventRefused({}))
        yield* watching.renew()
        yield* Queue.take(executor.subscribed)
        expect(yield* stateOf(idOf(first.url))).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'refused' })),
        )
        // At creation, Executor's own refusal to verify the callback leaves no Watch behind.
        yield* Queue.offer(executor.answers, new ExecutorCallbackFailed({ reason: 'timeout' }))
        const refused = yield* Effect.flip(watching.create(actor, { ...request, name: 'Other' }))
        expect(refused._tag).toBe('ExecutorCallbackFailed')
        const asked = yield* Queue.take(executor.subscribed)
        expect(yield* stateOf(idOf(asked.url))).toEqual(Option.none())
      }).pipe(Effect.scoped),
    )
  })
})
