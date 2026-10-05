import { googlePlace } from '@vivid/state'
import { Effect, Option } from 'effect'
import { reload } from './account'
import { send, start } from './app'
import {
  adopting,
  adoptSession,
  BrowserUnopened,
  Handing,
  handOff,
  opening,
  pairingTransport,
  Way,
  wayIn,
  type Handoff,
} from './pairing'

/**
 * Signing in with Google from the desktop app, as the welcome screen sees it: which way this
 * window has, whether a hand-off is happening, where it stands, and what a Person can do about
 * it (start, open the browser again, try the last step again, cancel).
 *
 * Only the desktop app has it. In a browser tab Google sign-in is a redirect and none of this
 * runs. The desktop app's preload puts one narrow capability on the window for it,
 * `vivid.openApproval`, which sends this server's approval page for a code to the system browser
 * and refuses every other address (`isApprovalAddress` in the desktop app's `main/security.ts`).
 * An ordinary link to that page would stay inside the window, because it is on the app's own
 * origin, and Google will not sign anyone in there. A desktop app installed before that
 * capability existed has neither way, and `way` says so (`wayIn`).
 *
 * It is a store read with `useSyncExternalStore`, not a hook, because the exchange outlives any
 * one drawing of the welcome and is started by a press, never by a render.
 */

/** Which way this window signs in with Google, read once from the bridge the shell put on it. */
const way = wayIn('vivid' in globalThis ? Option.some<unknown>(globalThis.vivid) : Option.none())

/** Where the hand-off stands: nothing is running, or it is at this state. */
let state: Option.Option<Handing> = Option.none()
/** Stops what is running. Does nothing when nothing is. */
let stop = () => {}
const listeners = new Set<() => void>()

const set = (next: Option.Option<Handing>) => {
  state = next
  for (const listener of listeners) listener()
}

const show = (next: Handing) => Effect.sync(() => set(Option.some(next)))

/**
 * Opens the system browser on the approval page for a code, with Google sign-in started there
 * (`googlePlace`, the address the phone opens too). The address is this page's own origin plus
 * that place, which is exactly what the desktop app will accept.
 *
 * A shell that refuses, or a browser that will not open, is a failure the card shows; it is never
 * swallowed, because a Person told "your browser opens" beside a browser that did not would wait
 * for nothing. Only a window with the capability can start a hand-off, so the other ways fail too.
 */
const open = (userCode: string) =>
  Way.$match(way, {
    Browser: () => Effect.fail(new BrowserUnopened({})),
    Outdated: () => Effect.fail(new BrowserUnopened({})),
    Shell: ({ openApproval }) =>
      Effect.tryPromise({
        try: () => openApproval(new URL(googlePlace(userCode), location.origin).href),
        catch: () => new BrowserUnopened({}),
      }),
  })

/** Everything a hand-off in this window touches. `destination` is where the app starts again. */
const parts = (destination: string): Handoff => ({
  transport: pairingTransport,
  open,
  adopt: adoptSession,
  show,
  arrive: Effect.sync(() => reload(destination)),
})

/** Runs one program in place of whatever was running, so two never write the same state. */
const replace = (program: Effect.Effect<void>) => {
  stop()
  stop = start(program)
}

export const googleHandoff = {
  /** Which way this window signs in with Google: a redirect, the hand-off, or not at all. */
  way,
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
  start: (destination: string) => replace(handOff(parts(destination))),
  /**
   * Opens the browser again with the code this window is already waiting on, for a Person who
   * closed it, came back without finishing, or was told it did not open. It does not ask for a
   * new code, and the exchange goes on asking underneath.
   *
   * What it shows is written only while that code is still the one being waited on: an approval
   * that lands while the browser is opening must not be painted over by "the browser opened".
   */
  reopen: () => {
    if (Option.isNone(state) || !Handing.$is('Waiting')(state.value)) return
    const { userCode } = state.value
    const whileWaiting = (next: Handing) =>
      Effect.sync(() => {
        const still =
          Option.isSome(state) &&
          Handing.$is('Waiting')(state.value) &&
          state.value.userCode === userCode
        if (still) set(Option.some(next))
      })
    void send(opening({ open, show: whileWaiting }, userCode))
  },
  /**
   * Tries the last step again: the trade of the approved token for the cookie, with the token the
   * `Unfinished` state holds. No new code is needed; the approval already happened.
   */
  retry: (destination: string) => {
    if (Option.isSome(state) && Handing.$is('Unfinished')(state.value))
      replace(adopting(parts(destination), state.value.token))
  },
  /**
   * Stops and goes back to the form. A code that was waiting is left to run out on the server,
   * and a token that was held for another try is dropped with the state that held it.
   */
  cancel: () => {
    stop()
    stop = () => {}
    set(Option.none())
  },
}
