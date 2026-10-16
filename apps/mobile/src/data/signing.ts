import { Data, Effect, Queue, Stream } from 'effect'
import * as Atom from 'effect/reactivity/Atom'
import * as Crypto from 'expo-crypto'
import { Linking } from 'react-native'
import { signIn, signOut, signUp } from './account'
import { door } from './door'
import { makeGoogle, PhoneUnable, Standing, TradeUnanswered, type Phone } from './google'
import { adopt, leave } from './held'
import type { ServerAddress } from './server'
import { Session, type SignedIn } from './session'
import { request } from './transport'

/**
 * Signing in and out, as atoms the sign-in screen reads and writes.
 *
 * Each one ends by adopting a session (`session.ts`), which is the single write that takes the
 * app from the sign-in screen to the Person's Threads and back. A screen never holds a token.
 */

const unable = () => new PhoneUnable({})

/**
 * What signing in with Google asks of this phone (`Phone` in `google.ts`), bound to Expo's
 * crypto and React Native's own `Linking`. This is the one place those are called for it, each
 * wrapped where its Promise or its exception is.
 *
 * `open` is `Linking.openURL`, which hands the address to the system browser and answers once
 * the system has taken it; it rejects when nothing on the phone opens web addresses.
 */
const phone: Phone = {
  random: (count) => Effect.try({ try: () => Crypto.getRandomBytes(count), catch: unable }),
  digest: (text) =>
    Effect.tryPromise({
      try: () =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
          encoding: Crypto.CryptoEncoding.BASE64,
        }),
      catch: unable,
    }),
  open: (address) =>
    Effect.asVoid(Effect.tryPromise({ try: () => Linking.openURL(address), catch: unable })),
  post: (address, body) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          request(address, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          }),
        catch: () => new TradeUnanswered({}),
      })
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => new TradeUnanswered({}),
      })
      return { ok: response.ok, body: text }
    }),
}

const standing = Atom.keepAlive(Atom.make<Standing>(Standing.Idle()))

/**
 * Where signing in with Google stands, for the first screen to draw. It holds the attempt's
 * secret while the Person is at the browser, wrapped, and in this registry only: nothing writes
 * it to the device.
 */
export const googleStandingAtom: Atom.Atom<Standing> = standing

const google = makeGoogle(phone, {
  standing: () => door.get(standing),
  show: (next) => door.set(standing, next),
  adopt: (server, token) => adopt(Session.SignedIn({ server, token })),
})

/**
 * Starts signing in with Google on a server: write the server to it and the browser opens. How
 * it goes is read from `googleStandingAtom`, not from this atom's own value.
 *
 * It is a plain function atom on purpose. Its run lasts as long as the attempt does, and a plain
 * function atom interrupts its last run when it is written to again (`makeResultFn` in effect
 * 4.0.0-rc.116's `Atom.ts`), which is exactly "a new press replaces the attempt before it". It is
 * kept alive because nothing reads it, and a function atom nobody reads is thrown away with its
 * run.
 */
export const googleAtom = Atom.keepAlive(Atom.fn(google.start))

/**
 * Every link the system opens the app with while this is subscribed to: React Native's `url`
 * event. The subscription is taken when the stream starts and removed when it ends.
 */
const links = Stream.callback<string>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Linking.addEventListener('url', (event) => {
        Queue.offerUnsafe(queue, event.url)
      }),
    ),
    (subscription) => Effect.sync(() => subscription.remove()),
  ),
)

/**
 * The other half of signing in with Google: hearing the link the browser hands back, and
 * finishing the attempt it belongs to (`makeGoogle`'s `returned`). The first screen reads this
 * atom for no value of its own; reading it is what keeps the phone listening for exactly as long
 * as the front door is on screen, and stops it once someone is signed in.
 *
 * Links are taken one at a time, so a second one that arrives while the first is being traded
 * finds no attempt waiting and is ignored.
 */
export const googleReturnsAtom = Atom.make(links.pipe(Stream.mapEffect(google.returned)))

/** What the email form holds when it is submitted. Only a new account gives a name. */
export type EmailEntry = Data.TaggedEnum<{
  Create: {
    readonly server: ServerAddress
    readonly name: string
    readonly email: string
    readonly password: string
  }
  Enter: { readonly server: ServerAddress; readonly email: string; readonly password: string }
}>
export const EmailEntry = Data.taggedEnum<EmailEntry>()

/** Creates an account or signs in to one, then adopts its session. Its value is how that went. */
export const emailAtom = Atom.fn(
  Effect.fn('Signing.email')(function* (entry: EmailEntry) {
    const token = yield* EmailEntry.$match(entry, {
      Create: ({ server, name, email, password }) => signUp(server, { name, email, password }),
      Enter: ({ server, email, password }) => signIn(server, { email, password }),
    })
    yield* adopt(Session.SignedIn({ server: entry.server, token }))
  }),
)

/**
 * Signs out. The Person is out of the app in the same turn this is written to: the token leaves
 * every screen and the live socket before the server or the device's store is asked anything
 * (`makeCustody`'s `leave`). A phone that is offline, a server that hangs and a store that
 * refuses must each still be able to sign out, and none of them may hold up the others.
 *
 * Nothing is said when the server gave no answer, as before: the request may or may not have
 * reached it, so that session may still be valid on the server until it expires. A store that
 * refused still holds the token and is on record separately (`forgettingAtom`), which the
 * sign-in screen shows. This atom's value carries no outcome, so an earlier sign-out finishing
 * late has nothing to say over a later one.
 *
 * It is `concurrent` because a plain function atom interrupts its last run when it is written to
 * again (`makeResultFn` in effect 4.0.0-rc.116's `Atom.ts`). A Person who signs back in and out
 * within the half minute the first sign-out may still be working would otherwise cut off the
 * request ending their earlier session.
 */
export const leaveAtom = Atom.keepAlive(
  Atom.fn(
    (session: SignedIn) => leave(Session.SignedOut({ server: session.server }), signOut(session)),
    { concurrent: true },
  ),
)
