import type { Theme } from '@vivid/contracts'

/**
 * How Vivid looks: light, dark, or whatever the system says. The choice is applied to the document
 * the moment it changes and remembered on this device, so a reload never flashes the wrong theme
 * while the Person's settings are on their way from the server.
 */

const KEY = 'vivid-theme'
const dark = matchMedia('(prefers-color-scheme: dark)')

const remembered = (): Theme => {
  const saved = localStorage.getItem(KEY)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

let preference: Theme = remembered()

const apply = () => {
  const resolved = preference === 'system' ? (dark.matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = resolved
}

// The system's own switch (sunset, a toggle in the menu bar) is followed while the choice is
// "system", without anything in React having to notice.
dark.addEventListener('change', apply)
apply()

export const theme = {
  current: () => preference,
  /** Adopts a choice: from this device's Settings, or from the Person's settings arriving live. */
  set: (next: Theme) => {
    if (next === preference) return
    preference = next
    localStorage.setItem(KEY, next)
    apply()
  },
}
