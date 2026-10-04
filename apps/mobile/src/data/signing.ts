import { Data, Effect, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Linking } from 'react-native'
import { pairingTransport, signIn, signOut, signUp } from './account'
import { Pairing, pairing } from './device'
import { googleAddress } from './google'
import type { ServerAddress } from './server'
import { adopt, leave } from './held'
import { Session, type SignedIn } from './session'

/**
 * Signing in and out, as atoms the sign-in screen reads and writes.
 *
 * Each one ends by adopting a session (`session.ts`), which is the single write that takes the
 * app from the sign-in screen to the Person's Threads and back. A screen never holds a token.
 */

/**
 * The code exchange against one server. It runs for exactly as long as something is reading it:
 * the sign-in screen showing it starts it, leaving that screen interrupts it mid-wait, and
 * refreshing the atom asks for a new code. When the code is entered on another device it adopts
 * the session itself, so the screen only ever draws the states before that.
 *
 * `onCode` is what happens once, when the code arrives. Signing in with a code does nothing: the
 * Person reads it off the screen. Signing in with Google opens the browser with it.
 */
const exchange = (server: ServerAddress, onCode: (userCode: string) => Effect.Effect<void>) =>
  Atom.make(
    pairing(pairingTransport(server)).pipe(
      Stream.tap((state) =>
        Pairing.$match(state, {
          Asking: () => Effect.void,
          Waiting: ({ userCode }) => onCode(userCode),
          Approved: ({ token }) => adopt(Session.SignedIn({ server, token })),
          Ended: () => Effect.void,
        }),
      ),
    ),
  )

export const pairingAtom = Atom.family((server: ServerAddress) =>
  exchange(server, () => Effect.void),
)

/**
 * Opens the system browser at the page where the Person signs in with Google and approves this
 * phone (`googleAddress`). A phone with no browser to open is not a reason to stop the exchange:
 * the step still shows the way to try again, and the code is still good.
 */
const openGoogle = (server: ServerAddress, userCode: string) =>
  Effect.ignore(Effect.tryPromise(() => Linking.openURL(googleAddress(server, userCode))))

/**
 * Signing in with Google: the same code exchange, with the browser opened as soon as there is a
 * code to approve. It is its own atom, so the code a Person was reading on the code step is not
 * the one the browser was opened with.
 */
export const googlePairingAtom = Atom.family((server: ServerAddress) =>
  exchange(server, (userCode) => openGoogle(server, userCode)),
)

/**
 * Opens the browser again with the code this phone is already waiting on, for a Person who came
 * back from it without finishing. It does not ask for a new code. It is kept alive because
 * nothing reads it: a function atom nobody reads is otherwise thrown away with its run.
 */
export const reopenGoogleAtom = Atom.keepAlive(
  Atom.fn((waiting: { readonly server: ServerAddress; readonly userCode: string }) =>
    openGoogle(waiting.server, waiting.userCode),
  ),
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
