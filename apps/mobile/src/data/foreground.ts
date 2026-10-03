import * as Atom from 'effect/unstable/reactivity/Atom'
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

/** The moment the app was last brought to the front; it starts as the moment it launched. */
let frontedAt = Date.now()

AppState.addEventListener('change', (state) => {
  if (state !== 'active') return
  frontedAt = Date.now()
  for (const wake of waiting) wake()
})

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
