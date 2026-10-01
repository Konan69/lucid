import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { RingWait } from '@vivid/contracts'
import { Ringer, ringerLayer } from './ring.ts'

/**
 * The relay that carries a ring from the laptop to the phone. Its two jobs are to hand over a
 * ring the moment a phone asks for one, and to forget a ring nobody collected, so a rehearsal
 * cannot make the phone ring in the middle of the real run.
 */

const call = { opening: 'Hi Tunde, it’s Vivid.', brief: 'The President approved the proposal.' }

describe('the ring relay', () => {
  it.effect('hands a waiting phone the ring that was placed', () =>
    Effect.gen(function* () {
      const ringer = yield* Ringer
      yield* ringer.ring(call)
      const waited = yield* ringer.wait
      assert.isTrue(RingWait.guards.Ring(waited))
      if (RingWait.guards.Ring(waited)) assert.deepStrictEqual(waited.call, call)
    }).pipe(Effect.provide(ringerLayer)),
  )

  it.effect('keeps a ring for a phone that checks in a moment later', () =>
    Effect.gen(function* () {
      const ringer = yield* Ringer
      yield* ringer.ring(call)
      yield* TestClock.adjust('10 seconds')
      assert.isTrue(RingWait.guards.Ring(yield* ringer.wait))
    }).pipe(Effect.provide(ringerLayer)),
  )

  it.effect('drops a ring nobody collected in time', () =>
    Effect.gen(function* () {
      const ringer = yield* Ringer
      yield* ringer.ring(call)
      yield* TestClock.adjust('3 minutes')
      assert.isTrue(RingWait.guards.Quiet(yield* ringer.wait))
    }).pipe(Effect.provide(ringerLayer)),
  )

  it.effect('replaces an uncollected ring, so one talk never rings a phone twice', () =>
    Effect.gen(function* () {
      const ringer = yield* Ringer
      yield* ringer.ring(call)
      yield* ringer.ring({ ...call, opening: 'Hi again' })
      const waited = yield* ringer.wait
      assert.isTrue(RingWait.guards.Ring(waited))
      if (RingWait.guards.Ring(waited)) assert.strictEqual(waited.call.opening, 'Hi again')
    }).pipe(Effect.provide(ringerLayer)),
  )
})
