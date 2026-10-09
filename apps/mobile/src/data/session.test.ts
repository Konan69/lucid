import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Redacted, Result, Schema } from 'effect'
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

/**
 * A write the store has begun and not finished. `begun` is the store's receipt that the write
 * reached it. `landing` is the store's own Promise for it, which nothing in Effect can cancel;
 * the write lands only when `settle` is called.
 */
interface Slow {
  readonly begun: Deferred.Deferred<void>
  readonly landing: Promise<void>
  readonly settle: () => void
}

const makeSlow = Effect.fn('Test.makeSlow')(function* () {
  const begun = yield* Deferred.make<void>()
  const { promise, resolve } = Promise.withResolvers<void>()
  return { begun, landing: promise, settle: () => resolve() } satisfies Slow
})

/** What one device holds: its store, whether that store will be written, and what the app shows. */
interface Device {
  locked: boolean
  /** When set, the next write is one the store is slow over, the way the Keychain can be. */
  slow: Option.Option<Slow>
  stored: Option.Option<string>
  shown: Session
  forgetting: Forgetting
}

/**
 * One device, as the rules see it: a store that holds a session's text and can be locked, and
 * the session the app is showing. It is the same shape `held.ts` gives the rules on a phone, with
 * the Keychain stood in for by a variable.
 *
 * A slow write is made the way `storage.ts` makes every write on a phone: a Promise inside
 * `Effect.tryPromise`, which nothing can cancel. Interrupting or timing out the Effect that asked
 * for it leaves it running, and it lands when it is settled.
 */
const makeDevice = () => {
  const device: Device = {
    locked: false,
    slow: Option.none(),
    stored: Option.none(),
    shown: Session.Unset(),
    forgetting: Forgetting.Done(),
  }
  const land = (session: Session) => {
    device.stored = writeKept(session, true)
  }
  const custody = makeCustody({
    write: (session) =>
      Effect.suspend(() => {
        const slow = device.slow
        if (Option.isSome(slow)) {
          return Effect.tryPromise({
            try: () => {
              Deferred.doneUnsafe(slow.value.begun, Effect.void)
              return slow.value.landing.then(() => land(session))
            },
            catch: () => new Locked({ message: 'The store is locked.' }),
          })
        }
        return device.locked
          ? Effect.fail(new Locked({ message: 'The store is locked.' }))
          : Effect.sync(() => land(session))
      }),
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

/** A server that is asked to end a session and never answers, counting how often it was asked. */
const makeStalledServer = () => {
  const stalled = { asked: 0, waiting: 0 }
  const revoke = Effect.suspend(() => {
    stalled.asked += 1
    stalled.waiting += 1
    return Effect.never
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        stalled.waiting -= 1
      }),
    ),
  )
  return { stalled, revoke }
}

describe('signing out of the server too', () => {
  it.effect('leaves the app at once while the server hangs and the store refuses', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      const { stalled, revoke } = makeStalledServer()
      yield* custody.adopt(signedIn('token-a'))

      device.locked = true
      const leaving = yield* Effect.forkChild(custody.leave(signedOut, revoke))
      yield* TestClock.adjust(0)
      // No time has passed and nothing has answered: the app is signed out all the same.
      expect(device.shown).toEqual(signedOut)
      // The store's refusal did not stand between the server and being told, nor the reverse.
      expect(stalled.asked).toBe(1)
      expect(device.forgetting).toEqual(Forgetting.Refused({ session: signedOut }))

      // Longer than either is given. It ends by itself, with no request left waiting that could
      // still be carrying the token.
      yield* TestClock.adjust('5 minutes')
      yield* Fiber.join(leaving)
      expect(stalled.asked).toBe(4)
      expect(stalled.waiting).toBe(0)
      expect(device.shown).toEqual(signedOut)
      expect(nextLaunch()).toEqual(signedIn('token-a'))
      expect(device.forgetting).toEqual(Forgetting.Refused({ session: signedOut }))
    }),
  )

  it.effect('tells the server while the store is still refusing', () =>
    Effect.gen(function* () {
      const { device, custody } = makeDevice()
      const answered = yield* Deferred.make<void>()
      yield* custody.adopt(signedIn('token-a'))

      device.locked = true
      const leaving = yield* Effect.forkChild(custody.leave(signedOut, Deferred.await(answered)))
      yield* TestClock.adjust(0)
      yield* Deferred.succeed(answered, undefined)
      yield* TestClock.adjust('5 minutes')

      // The server's answer and the store's refusal are both taken, and neither fails the other.
      yield* Fiber.join(leaving)
      expect(device.shown).toEqual(signedOut)
      expect(device.forgetting).toEqual(Forgetting.Refused({ session: signedOut }))
    }),
  )

  it.effect('forgets the token while the server hangs', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      const { revoke } = makeStalledServer()
      yield* custody.adopt(signedIn('token-a'))

      yield* Effect.forkChild(custody.leave(signedOut, revoke))
      yield* TestClock.adjust(0)
      expect(nextLaunch()).toEqual(signedOut)
      expect(device.forgetting).toEqual(Forgetting.Done())
    }),
  )

  it.effect('does not let a slow forgetting land on top of a later sign-in', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      const told = yield* Deferred.make<void>()
      const slow = yield* makeSlow()
      yield* custody.adopt(signedIn('token-a'))

      device.slow = Option.some(slow)
      const leaving = yield* Effect.forkChild(
        custody.leave(signedOut, Effect.asVoid(Deferred.succeed(told, undefined))),
      )
      // The store has the write and is sitting on it. The app is signed out and the server has
      // been told all the same.
      yield* Deferred.await(slow.begun)
      yield* Deferred.await(told)
      expect(device.shown).toEqual(signedOut)

      // The Person signs in again, with a store that would take this write at once, and the old
      // write stays unanswered for longer than anything here is given.
      device.slow = Option.none()
      const adopting = yield* Effect.forkChild(custody.adopt(signedIn('token-b')))
      yield* TestClock.adjust('5 minutes')
      // The sign-in has not gone ahead of the write it would be overwritten by. It is waiting,
      // and is not shown as signed in.
      expect(device.shown).toEqual(signedOut)
      expect(nextLaunch()).toEqual(signedIn('token-a'))
      expect(device.forgetting).toEqual(Forgetting.Underway({ session: signedOut }))

      // The old write lands, and only then the new one: the new session is what the store holds.
      yield* Effect.sync(slow.settle)
      yield* Fiber.join(adopting)
      yield* Fiber.join(leaving)
      expect(device.shown).toEqual(signedIn('token-b'))
      expect(nextLaunch()).toEqual(signedIn('token-b'))
      expect(device.forgetting).toEqual(Forgetting.Done())
    }),
  )

  it.effect('keeps the store until a write that was interrupted has landed', () =>
    Effect.gen(function* () {
      const { device, custody, nextLaunch } = makeDevice()
      const slow = yield* makeSlow()
      yield* custody.adopt(signedIn('token-a'))

      device.slow = Option.some(slow)
      const leaving = yield* Effect.forkChild(custody.drop(signedOut))
      yield* Deferred.await(slow.begun)

      // What asked for the write is stopped. The store goes on writing regardless.
      const stopping = yield* Effect.forkChild(Fiber.interrupt(leaving))
      device.slow = Option.none()
      const adopting = yield* Effect.forkChild(custody.adopt(signedIn('token-b')))
      yield* TestClock.adjust(0)
      expect(device.shown).toEqual(signedOut)
      expect(nextLaunch()).toEqual(signedIn('token-a'))

      yield* Effect.sync(slow.settle)
      yield* Fiber.join(adopting)
      yield* Fiber.join(stopping)
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
    expect(readKept(writeKept(signedIn('token-a'), false))).toEqual(signedOut)
  })

  it('reads anything that is not a session as a first launch', () => {
    expect(readKept(Option.none())).toEqual(Session.Unset())
    expect(readKept(Option.some('{"url":"not an address","token":"x"}'))).toEqual(Session.Unset())
    expect(readKept(Option.some('{"url":'))).toEqual(Session.Unset())
  })
})
