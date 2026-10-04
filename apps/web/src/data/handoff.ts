import { googlePlace, Pairing } from '@vivid/state'
import { Effect, Option } from 'effect'
import { reload } from './account'
import { send, start } from './app'
import { adoptSession, handOff, pairingTransport } from './pairing'

/**
 * Signing in with Google from the desktop app, as the welcome screen sees it: whether it is
 * happening, where it stands, and the three things a Person can do about it (start, open the
 * browser again, cancel).
 *
 * Only the desktop app has it. In a browser tab Google sign-in is a redirect and none of this
 * runs; `available` says which of the two this window is, the way `pages.available` does for
 * pages. The desktop app's preload puts one narrow capability on the window for it,
 * `vivid.openApproval`, which sends this server's approval page for a code to the system browser
 * and refuses every other address (`isApprovalAddress` in the desktop app's `main/security.ts`).
 * An ordinary link to that page would stay inside the window, because it is on the app's own
 * origin, and Google will not sign anyone in there.
 *
 * It is a store read with `useSyncExternalStore`, not a hook, because the exchange outlives any
 * one drawing of the welcome and is started by a press, never by a render.
 */

/** The desktop app's capability to open an approval page, when this window is the desktop app. */
const shell = 'vivid' in globalThis ? Option.some(globalThis.vivid.openApproval) : Option.none()

/** Where the hand-off stands: nothing is running, or the exchange is at this state. */
let state: Option.Option<Pairing> = Option.none()
/** Stops the exchange that is running. Does nothing when none is. */
let stop = () => {}
const listeners = new Set<() => void>()

const set = (next: Option.Option<Pairing>) => {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Opens the system browser on the approval page for a code, with Google sign-in started there
 * (`googlePlace`, the address the phone opens too). The address is this page's own origin plus
 * that place, which is exactly what the desktop app will accept.
 *
 * A browser that could not be opened is not a reason to stop: the code is still good, and the
 * screen still offers to open it again. The phone treats `Linking.openURL` the same way.
 */
const open = (userCode: string) =>
  Option.match(shell, {
    onNone: () => Effect.void,
    onSome: (openApproval) =>
      Effect.ignore(
        Effect.tryPromise(() => openApproval(new URL(googlePlace(userCode), location.origin).href)),
      ),
  })

export const googleHandoff = {
  /** Whether this window signs in with Google through the system browser: the desktop app. */
  available: Option.isSome(shell),
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  current: () => state,
  /**
   * Starts a hand-off, in place of any that was running: a new code is asked for and the browser
   * opens when it arrives. `destination` is where the Person was going, and where the app starts
   * again once this window is signed in.
   */
  start: (destination: string) => {
    stop()
    stop = start(
      handOff({
        transport: pairingTransport,
        open,
        adopt: adoptSession,
        show: (next) => Effect.sync(() => set(Option.some(next))),
        arrive: Effect.sync(() => reload(destination)),
      }),
    )
  },
  /**
   * Opens the browser again with the code this window is already waiting on, for a Person who
   * closed it or came back without finishing. It does not ask for a new code.
   */
  reopen: () => {
    if (Option.isSome(state) && Pairing.$is('Waiting')(state.value))
      void send(open(state.value.userCode))
  },
  /** Stops waiting and goes back to the form. The code is left to run out on the server. */
  cancel: () => {
    stop()
    stop = () => {}
    set(Option.none())
  },
}
