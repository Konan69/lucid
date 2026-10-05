import { useSyncExternalStore } from 'react'
import { BackHandler, Keyboard } from 'react-native'
import { makeMutable, ReduceMotion, withSpring } from 'react-native-reanimated'

/**
 * The drawer's state: how far out it is, and whether it is open.
 *
 * `travel` is the one moving value, 0 closed to 1 open, read by the drawer's panel and scrim on
 * the UI thread; a finger writes it directly while dragging. `opened` is the settled fact React
 * draws from (which gesture is live, what a screen reader can reach). There is one drawer in the
 * app, so both are module values, and anything may open or close it by calling the functions
 * here from JavaScript.
 *
 * Nothing in this module is touched from a worklet except `travel`. The functions below use the
 * keyboard and the back button, which are host objects a worklet cannot copy (capturing
 * `Keyboard` in a gesture callback crashed an earlier drawer); a gesture reaches them only
 * through `scheduleOnRN`.
 */
export const travel = makeMutable(0)

/**
 * A drawer is thrown or let go, so it moves on a spring that carries the finger's speed. It is
 * critically damped and clamped: a panel that overshot its edge would show the page behind it.
 */
export const DRAWER_SPRING = {
  damping: 34,
  stiffness: 340,
  mass: 1,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const

let opened = false
const listeners = new Set<() => void>()

/** Records where the drawer came to rest. Called from JavaScript, or by a gesture's end. */
export function settleDrawer(next: boolean) {
  if (opened === next) return
  opened = next
  for (const listener of listeners) listener()
}

/** Puts the keyboard away: a drawer opening over a focused field would leave it typing blind. */
export function hideKeyboard() {
  Keyboard.dismiss()
}

export function openDrawer() {
  hideKeyboard()
  travel.value = withSpring(1, DRAWER_SPRING)
  settleDrawer(true)
}

export function closeDrawer() {
  travel.value = withSpring(0, DRAWER_SPRING)
  settleDrawer(false)
}

// Android's back button closes an open drawer before it does anything else. Subscribed for the
// life of the app, as the keyboard store is: there is one drawer and it outlives every screen.
BackHandler.addEventListener('hardwareBackPress', () => {
  if (!opened) return false
  closeDrawer()
  return true
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const isOpened = () => opened

/** Whether the drawer has settled open. */
export const useDrawerOpened = (): boolean => useSyncExternalStore(subscribe, isOpened, isOpened)
