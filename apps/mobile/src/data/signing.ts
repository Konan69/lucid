import { Data, Effect, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { pairingTransport, signIn, signOut, signUp } from './account'
import { Pairing, pairing } from './device'
import type { ServerAddress } from './server'
import { adopt, Session, type SignedIn } from './session'

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
 * Signs out. The device forgets its token whether or not the server could be told: a phone that
 * is offline, or whose session the server already ended, must still be able to sign out. A
 * session the server was not told about stops working when it expires.
 */
export const leaveAtom = Atom.keepAlive(
  Atom.fn(
    Effect.fn('Signing.leave')(function* (session: SignedIn) {
      yield* Effect.ignore(signOut(session))
      yield* adopt(Session.SignedOut({ server: session.server }))
    }),
  ),
)
