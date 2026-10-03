import { useSyncExternalStore } from 'react'
import { Keyboard, Platform } from 'react-native'

/**
 * Whether the keyboard is up, as an external store.
 *
 * The composer sits on the home indicator's inset when the keyboard is down and directly on the
 * keyboard when it is up; that is a layout decision made during render, so the fact is read with
 * `useSyncExternalStore` and nothing is synchronised after it.
 *
 * iOS says the keyboard is coming before it moves, so the padding changes in the same animation
 * as the keyboard. Android only says once it has arrived.
 */

let showing = false
const listeners = new Set<() => void>()

const becomes = (next: boolean) => () => {
  showing = next
  for (const listener of listeners) listener()
}

// Subscribed for the life of the app: the keyboard exists whether or not a composer is mounted.
Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', becomes(true))
Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', becomes(false))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const isShowing = () => showing

export const useKeyboardShowing = (): boolean =>
  useSyncExternalStore(subscribe, isShowing, isShowing)
