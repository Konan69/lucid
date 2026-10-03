import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Option, Redacted, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { parseServer } from './server.ts'
import { Forgetting, makeCustody, readKept, Session, writeKept } from './session.ts'

const server = Result.getOrThrow(parseServer('http://192.168.1.20:5178'))

const signedIn = (token: string) => Session.SignedIn({ server, token: Redacted.make(token) })
const signedOut = Session.SignedOut({ server })

/** What a locked store answers a write with. */
class Locked extends Schema.TaggedError<Locked>()(
  'Locked',
  { message: Schema.String },
  { title: 'Store locked' },
) {}

/** What one device holds: its store, whether that store will be written, and what the app shows. */
interface Device {
  locked: boolean
  stored: Option.Option<string>
  shown: Session
  forgetting: Forgetting
}

/**
 * One device, as the rules see it: a store that holds a session's text and can be locked, and
 * the session the app is showing. It is the same shape `held.ts` gives the rules on a phone, with
 * the Keychain stood in for by a variable.
 */
const makeDevice = () => {
  const device: Device = {
    locked: false,
    stored: Option.none(),
    shown: Session.Unset(),
    forgetting: Forgetting.Done(),
  }
  const custody = makeCustody({
    write: (session) =>
      Effect.suspend(() =>
        device.locked
          ? Effect.fail(new Locked({ message: 'The store is locked.' }))
          : Effect.sync(() => {
              device.stored = Option.some(writeKept(session, true))
            }),
      ),
    show: (session) => {
      device.shown = session
    },
    owed: () => device.forgetting,
    owe: (next) => {
      device.forgetting = next
    },
  })
  return { device, custody, nextLaunch: () => readKept(device.stored) }
}

describe('signing out', () => {
  it.effect('leaves the app at once when the store will not be written, and says so', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      yield* custody.adopt(signedIn('token-a'))
      expect(device.shown).toEqual(signedIn('token-a'))

      device.locked = true
      const leaving = yield* Effect.forkChild(custody.drop(signedOut))
      yield* TestClock.adjust(0)
      // Signed out in the app, whatever the store did.
      expect(device.shown).toEqual(signedOut)
      // The store still holds the token, which the next launch would sign in with, and that is
      // on record for the sign-in screen to say.
      expect(nextLaunch()).toEqual(signedIn('token-a'))
      expect(device.forgetting).toEqual(Forgetting.Refused({ session: signedOut }))

      // It is tried again by itself; once the store opens, the token is gone from it too.
      device.locked = false
      yield* TestClock.adjust('1 second')
      yield* Fiber.join(leaving)
      expect(nextLaunch()).toEqual(signedOut)
      expect(device.forgetting).toEqual(Forgetting.Done())
    }),
  )

  it.effect('stays refused when the store never opens, until it is asked again', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      yield* custody.adopt(signedIn('token-a'))

      device.locked = true
      const leaving = yield* Effect.forkChild(Effect.result(custody.drop(signedOut)))
      // Longer than every retry it makes by itself.
      yield* TestClock.adjust('5 minutes')
      expect(Result.isFailure(yield* Fiber.join(leaving))).toBe(true)
      expect(device.shown).toEqual(signedOut)
      expect(device.forgetting).toEqual(Forgetting.Refused({ session: signedOut }))

      // "Try again" on the sign-in screen, with the store open now.
      device.locked = false
      yield* custody.forget()
      expect(nextLaunch()).toEqual(signedOut)
      expect(device.forgetting).toEqual(Forgetting.Done())
    }),
  )

  it.effect('does not sign a Person back out who signed in again before the store caught up', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      yield* custody.adopt(signedIn('token-a'))

      device.locked = true
      const leaving = yield* Effect.forkChild(custody.drop(signedOut))
      yield* TestClock.adjust(0)

      // The store opens and the Person signs in again while a retry is still waiting its turn.
      device.locked = false
      yield* custody.adopt(signedIn('token-b'))
      yield* TestClock.adjust('5 minutes')
      yield* Fiber.join(leaving)

      // The late retry found nothing left to forget and wrote nothing over the new session.
      expect(device.shown).toEqual(signedIn('token-b'))
      expect(nextLaunch()).toEqual(signedIn('token-b'))
      expect(device.forgetting).toEqual(Forgetting.Done())
    }),
  )
})

describe('signing in', () => {
  it.effect('is not shown as signed in when the store could not keep it', () =>
    Effect.gen(function* () {
      const { device, custody } = makeDevice()
      yield* custody.adopt(signedOut)

      device.locked = true
      const kept = yield* Effect.result(custody.adopt(signedIn('token-a')))
      expect(Result.isFailure(kept)).toBe(true)
      expect(device.shown).toEqual(signedOut)
    }),
  )
})

describe('what the store holds', () => {
  it('never hands the token to a store that anything can read', () => {
    // The browser preview's store: the address survives a reload, the sign-in does not.
    expect(readKept(Option.some(writeKept(signedIn('token-a'), false)))).toEqual(signedOut)
  })

  it('reads anything that is not a session as a first launch', () => {
    expect(readKept(Option.none())).toEqual(Session.Unset())
    expect(readKept(Option.some('{"url":"not an address","token":"x"}'))).toEqual(Session.Unset())
    expect(readKept(Option.some('{"url":'))).toEqual(Session.Unset())
  })
})
