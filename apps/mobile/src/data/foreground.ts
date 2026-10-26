import * as Atom from 'effect/reactivity/Atom'
import { useSyncExternalStore } from 'react'
import { AppState, type View } from 'react-native'

/**
 * Coming back to the app.
 *
 * A phone suspends an app it is not showing, and the app's socket does not survive that. The live
 * queries open again on their own once the socket is found dead (`@vivid/state`), which can take
 * a quarter of a minute; a conversation the Person has just come back to should not wait for
 * that. This is the one subscription that has it asked for again at once, held for the life of
 * the app; a screen only says what to do while it is on screen.
 */

const waiting = new Set<() => void>()

/**
 * What each mounted screen does to catch its conversation up (`onCatchUp`). It is run when the
 * app comes back to the front and when the app's own socket reopens after a loss
 * (`reconnected`): the conversation is subscribed to again, which begins with it whole
 * (`conversations`, `@vivid/state`), instead of after the moment a lost link waits before it
 * opens the next.
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
 * subscribes to it again now.
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
