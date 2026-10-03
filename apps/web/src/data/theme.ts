import { Theme } from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { kept } from './kept'

/**
 * How Vivid looks: light, dark, or whatever the system says. The choice is applied to the document
 * the moment it changes and remembered on this device, so a reload never flashes the wrong theme
 * while the Person's settings are on their way from the server.
 */

const KEY = 'vivid-theme'
const dark = matchMedia('(prefers-color-scheme: dark)')

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The choice this browser kept, when it kept one it still understands. */
const remembered = (): Theme =>
  Option.getOrElse(Option.flatMap(kept.read(KEY), decodeTheme), () => 'system')

let preference: Theme = remembered()

const apply = () => {
  const resolved = preference === 'system' ? (dark.matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = resolved
}

// The system's own switch (sunset, a toggle in the menu bar) is followed while the choice is
// "system", without anything in React having to notice.
dark.addEventListener('change', apply)
apply()

const media = {
  /** Told when the look actually on screen changes: a choice here, or the system's own switch. */
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    dark.addEventListener('change', listener)
    return () => {
      listeners.delete(listener)
      dark.removeEventListener('change', listener)
    }
  },
}
const listeners = new Set<() => void>()

export const theme = {
  current: () => preference,
  /** Light or dark as it is drawn right now, for the few things that are painted, not styled. */
  shown: (): 'light' | 'dark' =>
    preference === 'system' ? (dark.matches ? 'dark' : 'light') : preference,
  subscribe: media.subscribe,
  /** Adopts a choice: from this device's Settings, or from the Person's settings arriving live. */
  set: (next: Theme) => {
    if (next === preference) return
    preference = next
    kept.write(KEY, next)
    apply()
    for (const listener of listeners) listener()
  },
}
