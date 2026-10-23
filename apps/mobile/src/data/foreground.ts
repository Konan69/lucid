import * as Atom from 'effect/reactivity/Atom'
import { useSyncExternalStore } from 'react'
import { AppState, type View } from 'react-native'

/**
 * Coming back to the app.
 *
 * A phone suspends an app it is not showing, and a conversation's stream does not survive that.
 * The live queries reconnect on their own (`@vivid/state`), but a conversation is Flue's stream
 * and has to be told to catch up. This is the one subscription that does it, held for the life of
 * the app; a screen only says what to do while it is on screen.
 */

const waiting = new Set<() => void>()

/**
 * What each mounted screen does to catch its conversation up (`onCatchUp`). It is run when the app comes back
 * to the front and when the app's own socket reopens after a loss (`reconnected`): a network that
 * changed or a server that was replaced cuts Flue's stream as surely as a suspended app does, and
 * left alone the stream only notices after ninety silent seconds (`@flue/sdk` 2.2.2
 * `STALE_STREAM_TIMEOUT_MS`). The socket notices within fifteen (`@vivid/rpc` `layerLive`).
 */
const catching = new Set<() => void>()

/** The moment the app was last brought to the front; it starts as the moment it launched. */
let frontedAt = Date.now()

AppState.addEventListener('change', (state) => {
  if (state !== 'active') return
  frontedAt = Date.now()
  for (const wake of waiting) wake()
  for (const wake of catching) wake()
})

/**
 * The app's socket opened again after it was lost. Every screen that follows a conversation
 * opens its stream again now, from where it stopped, instead of waiting out Flue's own timer.
 */
export const reconnected = () => {
  for (const wake of catching) wake()
}

/**
 * A ref for a screen's root view. While that view is mounted, `wake` runs each time the app
 * returns to the foreground; React calls the returned cleanup when the view goes away, so the
 * subscription lives exactly as long as the screen and no effect hook is involved.
 */
export const onForeground =
  (wake: () => void) =>
  (view: View | null): (() => void) => {
    if (view !== null) waiting.add(wake)
    return () => {
      waiting.delete(wake)
    }
  }

/**
 * The same ref for a screen that follows a conversation: `wake` runs when the app returns to the
 * front and also when its socket reopens after a loss (`reconnected`). A screen that only cares
 * that the Person came back uses `onForeground`.
 */
export const onCatchUp =
  (wake: () => void) =>
  (view: View | null): (() => void) => {
    if (view !== null) catching.add(wake)
    return () => {
      catching.delete(wake)
    }
  }

const subscribe = (listener: () => void) => {
  waiting.add(listener)
  return () => {
    waiting.delete(listener)
  }
}

const readFrontedAt = () => frontedAt

/**
 * "Now", for grouping a list by day. It is the moment the app last came to the front, not a
 * ticking clock: a list should not reshuffle under a finger, but an app left open overnight must
 * not go on calling yesterday "Today" when it is picked up again.
 */
export const useNow = (): number => useSyncExternalStore(subscribe, readFrontedAt, readFrontedAt)

/**
 * Whether the app is in front, as an atom, for data that should only be said while the Person is
 * actually looking: being present in a Thread. An app in the background is not watching it.
 */
export const inFront = Atom.make((get) => {
  const heard = AppState.addEventListener('change', (state) => get.setSelf(state === 'active'))
  get.addFinalizer(() => heard.remove())
  return AppState.currentState === 'active'
})
