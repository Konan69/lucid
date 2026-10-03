import { Data, Effect, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { pairingTransport, signIn, signOut, signUp } from './account'
import { Pairing, pairing } from './device'
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
 */
export const pairingAtom = Atom.family((server: ServerAddress) =>
  Atom.make(
    pairing(pairingTransport(server)).pipe(
      Stream.tap((state) =>
        Pairing.$is('Approved')(state)
          ? adopt(Session.SignedIn({ server, token: state.token }))
          : Effect.void,
      ),
    ),
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
