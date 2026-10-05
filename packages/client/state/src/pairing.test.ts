import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Redacted, Ref, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  approvalPlace,
  googlePlace,
  Pairing,
  pairing,
  spellCode,
  Wire,
  type PairingTransport,
} from './pairing.js'

/** The body Better Auth's `/device/code` answers with, for a code good for `lifetime` seconds. */
const issued = (lifetime: number) =>
  Wire.Answered({
    ok: true,
    body: JSON.stringify({
      device_code: 'device-secret',
      user_code: 'ABCD2345',
      verification_uri: 'http://vivid.test/device',
      verification_uri_complete: 'http://vivid.test/device?user_code=ABCD2345',
      expires_in: lifetime,
      interval: 5,
    }),
  })

/** The body `/device/token` answers with while it will not hand over a token. */
const refusal = (error: string) =>
  Wire.Answered({ ok: false, body: JSON.stringify({ error, error_description: error }) })

const granted = Wire.Answered({
  ok: true,
  body: JSON.stringify({ access_token: 'session-token', token_type: 'Bearer', expires_in: 3600 }),
})

/**
 * Runs one exchange against a server that answers the token request with `answers` in order and
 * says "pending" once they run out. It reports the states drawn so far, how many times the
 * token was asked for, and the fiber, so a test can move the clock and look.
 */
const exchange = Effect.fn('Test.exchange')(function* (code: Wire, answers: ReadonlyArray<Wire>) {
  const drawn = yield* Ref.make<ReadonlyArray<Pairing>>([])
  const asked = yield* Ref.make(0)
  const transport: PairingTransport = {
    requestCode: Effect.succeed(code),
    askToken: () =>
      Ref.modify(asked, (count) => {
        const answer = answers[count]
        return [answer === undefined ? refusal('authorization_pending') : answer, count + 1]
      }),
  }
  const fiber = yield* pairing(transport).pipe(
    Stream.runForEach((state) => Ref.update(drawn, (states) => [...states, state])),
    Effect.forkScoped,
  )
  // Lets the exchange reach its first wait before the test starts moving the clock.
  yield* TestClock.adjust(0)
  return { drawn: Ref.get(drawn), asked: Ref.get(asked), fiber }
})

const waiting = [Pairing.Asking(), Pairing.Waiting({ userCode: 'ABCD2345' })]

describe('signing in with a code', () => {
  it.effect('shows the code and leaves one interval before it first asks', () =>
    Effect.gen(function* () {
      const run = yield* exchange(issued(600), [refusal('authorization_pending'), granted])
      expect(yield* run.drawn).toEqual(waiting)
      expect(yield* run.asked).toBe(0)

      yield* TestClock.adjust('4 seconds')
      expect(yield* run.asked).toBe(0)
      yield* TestClock.adjust('1 second')
      expect(yield* run.asked).toBe(1)
      expect(yield* run.drawn).toEqual(waiting)

      yield* TestClock.adjust('5 seconds')
      expect(yield* run.asked).toBe(2)
      expect(yield* run.drawn).toEqual([
        ...waiting,
        Pairing.Approved({ token: Redacted.make('session-token') }),
      ])
    }),
  )

  it.effect('asks five seconds later each time the server says to slow down', () =>
    Effect.gen(function* () {
      const run = yield* exchange(issued(600), [
        refusal('slow_down'),
        refusal('authorization_pending'),
        granted,
      ])
      yield* TestClock.adjust('5 seconds')
      expect(yield* run.asked).toBe(1)

      // The pace is now ten seconds, and stays ten after a plain "pending".
      yield* TestClock.adjust('9 seconds')
      expect(yield* run.asked).toBe(1)
      yield* TestClock.adjust('1 second')
      expect(yield* run.asked).toBe(2)
      yield* TestClock.adjust('9 seconds')
      expect(yield* run.asked).toBe(2)
      yield* TestClock.adjust('1 second')
      expect(yield* run.asked).toBe(3)
    }),
  )

  it.effect('keeps a code alive through a request that got no answer, asking less often', () =>
    Effect.gen(function* () {
      const run = yield* exchange(issued(600), [Wire.Unreachable(), granted])
      yield* TestClock.adjust('5 seconds')
      expect(yield* run.drawn).toEqual(waiting)
      yield* TestClock.adjust('10 seconds')
      expect(yield* run.drawn).toEqual([
        ...waiting,
        Pairing.Approved({ token: Redacted.make('session-token') }),
      ])
    }),
  )

  it.effect('ends with the reason the server gave', () =>
    Effect.gen(function* () {
      const expired = yield* exchange(issued(600), [refusal('expired_token')])
      const denied = yield* exchange(issued(600), [refusal('access_denied')])
      const unknown = yield* exchange(issued(600), [refusal('invalid_grant')])
      yield* TestClock.adjust('5 seconds')
      expect(yield* expired.drawn).toEqual([...waiting, Pairing.Ended({ why: 'expired' })])
      expect(yield* denied.drawn).toEqual([...waiting, Pairing.Ended({ why: 'denied' })])
      expect(yield* unknown.drawn).toEqual([...waiting, Pairing.Ended({ why: 'refused' })])

      // An ended exchange has stopped asking.
      yield* TestClock.adjust('1 minute')
      expect(yield* expired.asked).toBe(1)
    }),
  )

  it.effect('stops at the end of the code’s life even if the server never says it expired', () =>
    Effect.gen(function* () {
      const run = yield* exchange(issued(12), [])
      yield* TestClock.adjust('11 seconds')
      expect(yield* run.asked).toBe(2)
      expect(yield* run.drawn).toEqual(waiting)
      yield* TestClock.adjust('1 second')
      expect(yield* run.drawn).toEqual([...waiting, Pairing.Ended({ why: 'expired' })])
      yield* TestClock.adjust('1 minute')
      expect(yield* run.asked).toBe(2)
    }),
  )

  it.effect('never asks for a token when no code was issued', () =>
    Effect.gen(function* () {
      const away = yield* exchange(Wire.Unreachable(), [])
      const refused = yield* exchange(Wire.Answered({ ok: false, body: 'Not Found' }), [])
      const garbled = yield* exchange(Wire.Answered({ ok: true, body: '{"user_code":7}' }), [])
      yield* TestClock.adjust('1 minute')
      expect(yield* away.drawn).toEqual([Pairing.Asking(), Pairing.Ended({ why: 'unreachable' })])
      expect(yield* refused.drawn).toEqual([Pairing.Asking(), Pairing.Ended({ why: 'refused' })])
      expect(yield* garbled.drawn).toEqual([Pairing.Asking(), Pairing.Ended({ why: 'refused' })])
      expect(yield* away.asked).toBe(0)
      expect(yield* refused.asked).toBe(0)
    }),
  )

  it.effect('stops asking the moment it is interrupted', () =>
    Effect.gen(function* () {
      const run = yield* exchange(issued(600), [])
      yield* TestClock.adjust('5 seconds')
      expect(yield* run.asked).toBe(1)

      // What leaving the sign-in screen does to the exchange it was showing.
      yield* Fiber.interrupt(run.fiber)
      yield* TestClock.adjust('1 minute')
      expect(yield* run.asked).toBe(1)
      expect(yield* run.drawn).toEqual(waiting)
    }),
  )
})

describe('a code as it is read aloud', () => {
  it('is split into two halves', () => {
    expect(spellCode('ABCD2345')).toBe('ABCD-2345')
    expect(spellCode('ABC234')).toBe('ABC-234')
  })

  it('is left alone when it has no middle', () => {
    expect(spellCode('ABCDE')).toBe('ABCDE')
    expect(spellCode('AB')).toBe('AB')
  })
})

describe('where a waiting device is let in', () => {
  /** A stand-in for the origin an app puts in front of the place. */
  const at = (place: string) => new URL(place, 'https://vivid.example.com')

  it('is the approval page with the code filled in', () => {
    const page = at(approvalPlace('ABCD2345'))
    expect(page.pathname).toBe('/device')
    expect(Object.fromEntries(page.searchParams)).toEqual({ user_code: 'ABCD2345' })
  })

  it('asks the web to start Google when that is how the Person is signing in', () => {
    const page = at(googlePlace('ABCD2345'))
    expect(page.pathname).toBe('/device')
    expect(Object.fromEntries(page.searchParams)).toEqual({
      user_code: 'ABCD2345',
      signin: 'google',
    })
  })

  it('keeps a code with characters an address would otherwise read as its own', () => {
    const page = at(googlePlace('AB&signin=x'))
    expect(page.searchParams.get('user_code')).toBe('AB&signin=x')
    expect(page.searchParams.getAll('signin')).toEqual(['google'])
  })
})
