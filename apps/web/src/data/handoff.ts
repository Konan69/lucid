import { Effect, Option } from 'effect'
import { create } from 'zustand'
import { reload } from './account'
import { send, start } from './app'
import {
  browserSaid,
  endingSaid,
  Handing,
  handOff,
  landing,
  reopened,
  reopening,
  tradeCode,
  waitingOn,
  Way,
  wayIn,
  type Handoff,
  type Shown,
} from './signin'

/**
 * Signing in with Google from the desktop app, as the welcome screen sees it: which way this
 * window has, whether a hand-off is happening, where it stands, and what a Person can do about
 * it (start, open a browser that did not open, cancel).
 *
 * Only the desktop app has it. In a browser tab Google sign-in is a redirect and none of this
 * runs. The desktop app's preload puts one capability on the window for it, `vivid.signIn`: the
 * shell opens the system browser on Google and brings back a one-use code, which this window
 * trades for its session (`signin.ts`). A desktop app whose shell lacks that capability has
 * neither way, and `way` says so (`wayIn`).
 *
 * It is a store and not a screen's own state, because the hand-off outlives any one drawing of
 * the welcome and is started by a press, never by a render: a Zustand store, as T3 Code web keeps
 * its interface state (`apps/web/src/rightPanelStore.ts`).
 */

/** Which way this window signs in with Google, read once from the bridge the shell put on it. */
const way = wayIn('vivid' in globalThis ? Option.some<unknown>(globalThis.vivid) : Option.none())

/** What is on the screen: the form (no state) or the card, and the attempt that put it there. */
export const useHandoff = create<Shown>()(() => ({ attempt: 0, state: Option.none() }))
/** Stops what is running. It is the running hand-off's handle, not something drawn. */
let stop = () => {}

/** Puts a screen up. One that is already up (`reopened` hands the same one back) changes nothing. */
const set = (next: Shown) => useHandoff.setState(next, true)

/**
 * Writes for one attempt, and only while it is still the current one. Stopping a hand-off
 * interrupts it, but an interrupt lands at the hand-off's next step, not at once; this is what
 * keeps a step already under way from drawing over the form or over the attempt that replaced it.
 */
const during = (attempt: number, state: Option.Option<Handing>) =>
  Effect.sync(() => {
    if (useHandoff.getState().attempt === attempt) set({ attempt, state })
  })

/**
 * Everything one hand-off in this window touches. `destination` is where the Person was going;
 * the app starts again there, marked when Google just made their account (`landing`).
 */
const parts = (
  { signIn }: Extract<Way, { _tag: 'Shell' }>,
  attempt: number,
  destination: string,
): Handoff => ({
  begin: browserSaid(() => signIn.begin()),
  ended: endingSaid(() => signIn.ended()),
  trade: tradeCode,
  show: (state) => during(attempt, Option.some(state)),
  leave: during(attempt, Option.none()),
  arrive: (arrival) => Effect.sync(() => reload(landing(destination, arrival))),
})

export const googleHandoff = {
  /** Which way this window signs in with Google: a redirect, the hand-off, or not at all. */
  way,
  /**
   * Starts a new attempt, in place of any that was running: the shell opens the browser, and this
   * window waits for how it ends. `destination` is where the Person was going.
   *
   * It is also what "Try again" runs. A code is good once, so no step is ever repeated; the shell
   * drops the attempt it had when a new one begins.
   */
  start: (destination: string) => {
    if (!Way.$is('Shell')(way)) return
    stop()
    // The card is up before the hand-off takes its first step, so "Try again" never shows the
    // form for a moment between one attempt and the next.
    const attempt = useHandoff.getState().attempt + 1
    set({ attempt, state: Option.some(Handing.Opening()) })
    stop = start(handOff(parts(way, attempt, destination)))
  },
  /**
   * Opens the browser for the attempt this window is waiting on, for a Person who was told it
   * did not open: the card offers this in that step only. It starts no new attempt, and the wait
   * goes on underneath.
   *
   * What the shell answers is written only while the card is still waiting on that attempt
   * (`reopened`): a code that lands while the browser is opening must not be painted over.
   */
  reopen: () => {
    const { attempt } = useHandoff.getState()
    if (!Way.$is('Shell')(way) || !waitingOn(useHandoff.getState(), attempt)) return
    const { signIn } = way
    void send(
      reopening(browserSaid(() => signIn.reopen())).pipe(
        Effect.map((browser) => set(reopened(useHandoff.getState(), attempt, browser))),
      ),
    )
  },
  /**
   * Stops and goes back to the form. The shell is told, so it stops listening and a code that
   * arrives late is worth nothing. Whether the shell heard does not matter to this window, which
   * has stopped either way, so its answer is not waited on or read.
   */
  cancel: () => {
    stop()
    stop = () => {}
    if (Way.$is('Shell')(way)) {
      const { signIn } = way
      void send(Effect.ignore(Effect.tryPromise(() => signIn.cancel())))
    }
    set({ attempt: useHandoff.getState().attempt + 1, state: Option.none() })
  },
}
