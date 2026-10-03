import { Effect, Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Platform } from 'react-native'
import { door } from './door'
import { Forgetting, makeCustody, readKept, writeKept, type Session } from './session'
import { keep, recall } from './storage'

/**
 * The session this device holds: read from its protected store at launch, shown to the app as
 * one atom, and taken up or let go by the rules in `session.ts`. This is the only place those
 * rules meet the phone.
 */

const KEY = 'vivid-mobile'

/**
 * Only a real device keeps the token. The browser preview has nothing better than
 * `localStorage`, which any script on the page can read, so there it keeps the address alone and
 * a reload is signed out.
 */
const keepsToken = Platform.OS !== 'web'

/** What this device kept from its last run, or a first launch's state when it kept nothing. */
const remembered = Effect.fn('Session.remembered')(function* () {
  const kept = yield* recall(KEY).pipe(
    // A store that cannot be read holds nothing this run can act on. Signed out is then the
    // truth of the matter, and signing in again writes a fresh entry.
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  return readKept(kept)
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

const forgetting = Atom.keepAlive(Atom.make<Forgetting>(Forgetting.Done()))

/** How the store stands with the last session that was ended, for the sign-in screen to say. */
export const forgettingAtom: Atom.Atom<Forgetting> = forgetting

const custody = makeCustody({
  write: (session) => keep(KEY, writeKept(session, keepsToken)),
  show: (session) => door.set(adopted, Option.some(session)),
  owed: () => door.get(forgetting),
  owe: (next) => door.set(forgetting, next),
})

/** Makes a session this device's own: kept, then shown (`makeCustody`). */
export const adopt = custody.adopt

/** Ends this device's authority: out of the app at once, then out of the store. */
export const drop = custody.drop

/**
 * Signs out: out of the app at once, then the server and the store are told side by side
 * (`makeCustody`).
 */
export const leave = custody.leave

/**
 * `adopt` for callers that are not inside an Effect: write a session to it and the registry runs
 * the change. Its value says how the last change went.
 */
export const adoptAtom = Atom.keepAlive(Atom.fn(adopt))

/** `drop` for callers that are not inside an Effect, such as the live data ending a session. */
export const dropAtom = Atom.keepAlive(Atom.fn(drop))

/**
 * Asks the store again to forget a session it refused to (`Forgetting.Refused`), for the sign-in
 * screen's "Try again". Its value says how the last try went.
 */
export const forgetAtom = Atom.keepAlive(Atom.fn(custody.forget))
