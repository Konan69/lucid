import { describe, expect, it } from '@effect/vitest'
import { Pairing, Wire, type Ending, type PairingTransport } from '@vivid/state'
import { Effect, Redacted, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { handOff } from './pairing'

/** The body Better Auth's `/device/code` answers with. */
const issued = Wire.Answered({
  ok: true,
  body: JSON.stringify({
    device_code: 'device-secret',
    user_code: 'ABCD2345',
    expires_in: 600,
    interval: 5,
  }),
})

const pending = Wire.Answered({
  ok: false,
  body: JSON.stringify({ error: 'authorization_pending' }),
})
const denied = Wire.Answered({ ok: false, body: JSON.stringify({ error: 'access_denied' }) })
const granted = Wire.Answered({
  ok: true,
  body: JSON.stringify({ access_token: 'session-token', token_type: 'Bearer', expires_in: 3600 }),
})

/**
 * Runs one hand-off against a server that answers the token request with `answers` in order
 * ("pending" once they run out) and a cookie trade that ends as `trade` says. Everything the
 * hand-off did outside itself is recorded in the order it happened.
 */
const run = Effect.fn('Test.handOff')(function* (
  answers: ReadonlyArray<Wire>,
  trade: Effect.Effect<void, Ending>,
) {
  const did = yield* Ref.make<ReadonlyArray<string>>([])
  const note = (what: string) => Ref.update(did, (all) => [...all, what])
  const asked = yield* Ref.make(0)
  const transport: PairingTransport = {
    requestCode: Effect.succeed(issued),
    askToken: () =>
      Ref.modify(asked, (count) => {
        const answer = answers[count]
        return [answer === undefined ? pending : answer, count + 1]
      }),
  }
  yield* handOff({
    transport,
    open: (userCode) => note(`open ${userCode}`),
    adopt: (token) => Effect.andThen(note(`adopt ${Redacted.value(token)}`), trade),
    show: (state) =>
      note(Pairing.$is('Ended')(state) ? `show Ended ${state.why}` : `show ${state._tag}`),
    arrive: note('arrive'),
  }).pipe(Effect.forkScoped)
  yield* TestClock.adjust(0)
  return Ref.get(did)
})

const waiting = ['show Asking', 'show Waiting', 'open ABCD2345']

describe('signing the desktop window in through the browser', () => {
  it.effect('opens the browser once with the code, and waits', () =>
    Effect.gen(function* () {
      const did = yield* run([], Effect.void)
      expect(yield* did).toEqual(waiting)
      // Asking again does not open the browser again.
      yield* TestClock.adjust('30 seconds')
      expect(yield* did).toEqual(waiting)
    }),
  )

  it.effect('trades the granted token for a cookie before it arrives', () =>
    Effect.gen(function* () {
      const did = yield* run([pending, granted], Effect.void)
      yield* TestClock.adjust('10 seconds')
      expect(yield* did).toEqual([...waiting, 'show Approved', 'adopt session-token', 'arrive'])
    }),
  )

  it.effect('says why and does not arrive when the token could not become a cookie', () =>
    Effect.gen(function* () {
      const refused = yield* run([granted], Effect.fail('refused'))
      const away = yield* run([granted], Effect.fail('unreachable'))
      yield* TestClock.adjust('5 seconds')
      expect(yield* refused).toEqual([
        ...waiting,
        'show Approved',
        'adopt session-token',
        'show Ended refused',
      ])
      expect(yield* away).toEqual([
        ...waiting,
        'show Approved',
        'adopt session-token',
        'show Ended unreachable',
      ])
    }),
  )

  it.effect('ends without asking for a cookie when the browser said no', () =>
    Effect.gen(function* () {
      const did = yield* run([denied], Effect.void)
      yield* TestClock.adjust('5 seconds')
      expect(yield* did).toEqual([...waiting, 'show Ended denied'])
    }),
  )
})
