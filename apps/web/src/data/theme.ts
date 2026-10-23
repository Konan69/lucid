import { Theme } from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { create } from 'zustand'
import { kept } from './kept'

/**
 * How Vivid looks: light, dark, or whatever the system says. The choice is applied to the document
 * the moment it changes and remembered on this device, so a reload never flashes the wrong theme
 * while the Person's settings are on their way from the server.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * It holds the choice and what the system says, so the look on screen is one selector over both
 * (`themeShown`). The choice is read from the browser once, when the store is made, and written
 * by `theme.set`, as the bare word it always was; the notice's window reads that word
 * (`notice.tsx`).
 */

const KEY = 'vivid-theme'
const dark = matchMedia('(prefers-color-scheme: dark)')

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The choice this browser kept, when it kept one it still understands. */
const remembered = (): Theme =>
  Option.getOrElse(Option.flatMap(kept.read(KEY), decodeTheme), () => 'system')

interface Look {
  /** What the Person chose. */
  readonly preference: Theme
  /** Whether the system asks for dark right now. Follows `dark`, so a selector can read it. */
  readonly systemDark: boolean
}

export const useTheme = create<Look>()(() => ({
  preference: remembered(),
  systemDark: dark.matches,
}))

/** Light or dark as it is drawn right now, for the few things that are painted, not styled. */
export const themeShown = (state: Look): 'light' | 'dark' => {
  if (state.preference !== 'system') return state.preference
  return state.systemDark ? 'dark' : 'light'
}

// The document follows the store: a choice here, or the system's own switch (sunset, a toggle in
// the menu bar) while the choice is "system", without anything in React having to notice.
const apply = (state: Look) => {
  document.documentElement.dataset.theme = themeShown(state)
}
apply(useTheme.getState())
useTheme.subscribe(apply)

/**
 * In the desktop app, the shell is told the choice as well, so what the operating system draws for
 * the window (its minimise, maximise and close buttons, its menus) is in the same look as the
 * page. Without it the window kept the system's look: a Person who chose light on a dark system
 * had dark window buttons on a black strip over a light page.
 *
 * It is the choice that is sent, not what is drawn: given "system" the shell follows the system by
 * itself. A shell installed before this existed has no `colorScheme` on its bridge, though the
 * type says every shell does; that shell is simply not told. An answer that fails is left to
 * reject, so it is reported like any other fault and nothing here pretends it worked.
 */
const tell = (preference: Theme) => {
  if ('vivid' in globalThis && 'colorScheme' in globalThis.vivid)
    void globalThis.vivid.colorScheme.show(preference)
}
tell(useTheme.getState().preference)
useTheme.subscribe((state, before) => {
  if (state.preference !== before.preference) tell(state.preference)
})
dark.addEventListener('change', () => useTheme.setState({ systemDark: dark.matches }))

export const theme = {
  /** Adopts a choice: from this device's Settings, or from the Person's settings arriving live. */
  set: (next: Theme) => {
    if (next === useTheme.getState().preference) return
    useTheme.setState({ preference: next })
    kept.write(KEY, next)
  },
}
