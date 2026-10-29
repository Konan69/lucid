import { PHONE_SIGN_IN_RETURN } from '@vivid/contracts/signin'
import { Data, Effect, Option, Queue, Stream } from 'effect'
import * as Atom from 'effect/reactivity/Atom'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { Linking } from 'react-native'
import { signIn, signOut, signUp } from './account'
import { door } from './door'
import { makeGoogle, PhoneUnable, Standing, TradeUnanswered, type Phone } from './google'
import { adopt, leave } from './held'
import type { ServerAddress } from './server'
import { Session, type SignedIn } from './session'
import { captureSignInLoss } from './telemetry'
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
 * `open` is the platform's sign-in sheet (`expo-web-browser`: `ASWebAuthenticationSession` on
 * iOS, a Custom Tab on Android). It answers when the sheet closes, with the `vivid://signin` link
 * it closed on when there is one.
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
    Effect.tryPromise({
      try: () => WebBrowser.openAuthSessionAsync(address, PHONE_SIGN_IN_RETURN),
      catch: unable,
    }).pipe(
      Effect.map((result) =>
        result.type === 'success' ? Option.some(result.url) : Option.none<string>(),
      ),
    ),
  post: (address, body) =>
    Effect.tryPromise({
      // The body is read inside the same attempt as the request, so the one abort signal covers
      // both: an interrupted call (a timeout) stops a body still arriving, not only the headers.
      try: (signal) =>
        request(address, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        }).then((response) => response.text().then((text) => ({ ok: response.ok, body: text }))),
      catch: () => new TradeUnanswered({}),
    }),
}

const standing = Atom.keepAlive(Atom.make<Standing>(Standing.Idle()))

/**
 * Where signing in with Google stands, for the first screen to draw. It holds the attempt's
 * secret while the Person is at the browser, wrapped, and in this registry only: nothing writes
 * it to the device.
 */
export const googleStandingAtom: Atom.Atom<Standing> = standing

/**
 * Whether a Google sign-in is under way: the sheet is open (`Away`) or its code is being traded.
 * iOS reports the app as in the background while its sign-in sheet is up, and a restart into a
 * downloaded update then ended the app under the sheet: the attempt's secret went with the old
 * process and the Person landed back on the first screen (production, 29 October 2026: an update
 * downloaded as the sheet opened at 20:09:54 UTC, Google answered at 20:10:20 and no trade came).
 * A restart waits for this to be over, as it waits for the file picker (`isChoosing`).
 */
export const isSigningIn = (): boolean =>
  Standing.$is('Away')(door.get(standing)) || Standing.$is('Trading')(door.get(standing))

const google = makeGoogle(phone, {
  report: captureSignInLoss,
  standing: () => door.get(standing),
  show: (next) => door.set(standing, next),
  adopt: (server, token) => adopt(Session.SignedIn({ server, token })),
})

/**
 * Starts signing in with Google on a server: write the server to it and the browser opens. How
 * it goes is read from `googleStandingAtom`, not from this atom's own value.
 *
 * A plain function atom interrupts an unfinished browser-opening request when another press
 * replaces it. The attempt itself stays in googleStandingAtom until its return or replacement;
 * no client clock can expire the human step before the server has issued a trade grant.
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
export const googleReturnsAtom = Atom.setIdleTTL(
  Atom.make(
    links.pipe(
      Stream.mapEffect(google.returned),
      // Leaving the front door owns cancellation and secret disposal, even when email sign-in
      // replaced an unfinished Google attempt. Retaining a warm listener would retain its secret.
      Stream.ensuring(Effect.sync(() => door.set(standing, Standing.Idle()))),
    ),
  ),
  0,
)

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
 * A server refusal or missing acknowledgement is recorded as this atom's failure. The token
 * may still be valid on the server until it expires. A refused store is recorded separately
 * (`forgettingAtom`) and the sign-in screen already offers its manual retry.
 *
 * It is `concurrent` because a plain function atom interrupts its last run when it is written to
 * again (`makeResultFn` in effect 4.0.0-rc.116's `Atom.ts`). A Person who signs back in and out
 * while the first sign-out is still working would otherwise cut off the
 * request ending their earlier session.
 */
export const leaveAtom = Atom.keepAlive(
  Atom.fn(
    (session: SignedIn) => leave(Session.SignedOut({ server: session.server }), signOut(session)),
    { concurrent: true },
  ),
)
