import { Data, Effect, Option, Redacted, Result, Schema } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Platform } from 'react-native'
import { door } from './door'
import { parseServer, type ServerAddress } from './server'
import { keep, recall } from './storage'

/**
 * Where this device stands with a Vivid server.
 *
 * A browser is signed in by a cookie it never sees. A phone has no cookie: it holds a session
 * token and sends it as `authorization: Bearer …` on every call and on the live socket's
 * upgrade. The token and the server it belongs to are the whole of a session, kept in the
 * device's protected store between runs.
 *
 * - `Unset`: this device has never been told where its Vivid is. Nothing is assumed: no address
 *   is built into the app, so the first thing it asks for is the server.
 * - `SignedOut`: nobody is signed in here; `server` is where signing in will be tried.
 * - `Expired`: someone was signed in and the server stopped accepting their token (it ran out,
 *   or it was ended from another device). It is kept apart from `SignedOut` only so the sign-in
 *   screen can say what happened; it is stored the same way.
 * - `SignedIn`: every call carries `token`. It stays wrapped in `Redacted` so it cannot be
 *   printed by a log or an error on its way to the two places that send it.
 */
export type Session = Data.TaggedEnum<{
  Unset: {}
  SignedOut: { readonly server: ServerAddress }
  Expired: { readonly server: ServerAddress }
  SignedIn: { readonly server: ServerAddress; readonly token: Redacted.Redacted }
}>
export const Session = Data.taggedEnum<Session>()
export type SignedIn = Data.TaggedEnum.Value<Session, 'SignedIn'>
/** Every state in which the sign-in screen, not the app, is what the Person sees. */
export type Outside = Exclude<Session, SignedIn>
export const Outside = Data.taggedEnum<Outside>()

const KEY = 'vivid-mobile'

/**
 * A session as it is kept. An empty `token` is how "signed out" is written, which is also what
 * earlier builds of this app stored when no token had been entered, so an upgrade keeps the
 * server address a Person had already typed. An empty `url` is how "no server yet" is written.
 */
const Kept = Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.String }))
const decodeKept = Schema.decodeUnknownOption(Kept)
const encodeKept = Schema.encodeSync(Kept)

/**
 * Only a real device keeps the token. The browser preview has nothing better than
 * `localStorage`, which any script on the page can read, so there it keeps the address alone and
 * a reload is signed out.
 */
const keepsToken = Platform.OS !== 'web'

const keptOf = (session: Session) =>
  Session.$match(session, {
    Unset: () => ({ url: '', token: '' }),
    SignedOut: ({ server }) => ({ url: server, token: '' }),
    Expired: ({ server }) => ({ url: server, token: '' }),
    SignedIn: ({ server, token }) => ({
      url: server,
      token: keepsToken ? Redacted.value(token) : '',
    }),
  })

/** An address that no longer reads as a server is the same as never having been given one. */
const sessionOf = (kept: {
  readonly url: string
  readonly token: string
}): Option.Option<Session> =>
  Option.map(Result.getSuccess(parseServer(kept.url)), (server) =>
    kept.token === ''
      ? Session.SignedOut({ server })
      : Session.SignedIn({ server, token: Redacted.make(kept.token) }),
  )

/** What this device kept from its last run, or a first launch's state when it kept nothing. */
const remembered = Effect.fn('Session.remembered')(function* () {
  const kept = yield* recall(KEY).pipe(
    // A store that cannot be read holds nothing this run can act on. Signed out is then the
    // truth of the matter, and signing in again writes a fresh entry.
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  return kept.pipe(
    Option.flatMap(decodeKept),
    Option.flatMap(sessionOf),
    Option.getOrElse(() => Session.Unset()),
  )
})

const recalled = Atom.keepAlive(Atom.make(remembered()))
const adopted = Atom.keepAlive(Atom.make(Option.none<Session>()))

/**
 * The device's session: on its way from the store, then whatever was last adopted. Everything
 * that depends on who is signed in (the live data, which screen is shown) derives from this one
 * atom, so signing in, signing out and changing server are each a single write.
 */
export const sessionAtom = Atom.keepAlive(
  Atom.make((get): AsyncResult.AsyncResult<Session> =>
    Option.match(get(adopted), {
      onNone: () => get(recalled),
      onSome: (session) => AsyncResult.success(session),
    }),
  ),
)

/**
 * Makes a session this device's own. It is kept before it is shown, so a session the device
 * could not keep is never presented as signed in only to vanish at the next launch.
 */
export const adopt = Effect.fn('Session.adopt')(function* (session: Session) {
  yield* keep(KEY, encodeKept(keptOf(session)))
  yield* Effect.sync(() => door.set(adopted, Option.some(session)))
})

/**
 * `adopt` for callers that are not inside an Effect: write a session to it and the registry runs
 * the change. Its value says how the last change went.
 */
export const adoptAtom = Atom.keepAlive(Atom.fn(adopt))
