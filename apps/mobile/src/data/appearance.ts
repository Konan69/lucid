import { Theme } from '@vivid/contracts'
import { nativeTokens } from '@vivid/tokens/native'
import { Effect, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as SystemUI from 'expo-system-ui'
import { Appearance, Platform } from 'react-native'
import { door } from './door'
import { keep, recall } from './storage'

/**
 * How Vivid looks on this device: light, dark, or whatever the system says.
 *
 * The choice is the Person's and lives in their Settings on the server, so it follows them to
 * every device. This device also remembers the last choice it saw, because Settings arrive a
 * moment after launch and an app that opens in the wrong theme and then corrects itself is worse
 * than one that opens as it was left.
 *
 * Applying a choice is an event, done here when it changes; no component syncs it after render.
 */

const KEY = 'vivid-mobile-theme'
const decodeTheme = Schema.decodeUnknownOption(Theme)

/** What the system says it is showing; it can decline to say, which is read as light. */
type SystemScheme = ReturnType<typeof Appearance.getColorScheme>

/** Which palette a choice comes to, given what the system is showing right now. */
export const paletteOf = (theme: Theme, system: SystemScheme): 'light' | 'dark' => {
  if (theme !== 'system') return theme
  return system === 'dark' ? 'dark' : 'light'
}

/**
 * Tells the operating system which appearance the app wants, so native surfaces the app does not
 * draw itself (menus, pickers, the keyboard) match. The browser preview has no such switch.
 */
const applyToSystem = (theme: Theme) => {
  if (Platform.OS !== 'web') Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme)
}

/** The theme this device last saw, when it kept one. A device that kept nothing follows the system. */
const remembered = Effect.fn('Appearance.remembered')(function* () {
  const kept = yield* recall(KEY).pipe(
    // An unreadable store means no remembered choice, which is exactly a first launch.
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  const theme = Option.getOrElse(Option.flatMap(kept, decodeTheme), (): Theme => 'system')
  yield* Effect.sync(() => applyToSystem(theme))
  return theme
})

const recalled = Atom.keepAlive(Atom.make(remembered()))
const chosen = Atom.keepAlive(Atom.make(Option.none<Theme>()))

/** The theme in force: the last one chosen in this run, else the remembered one once it is read. */
export const themeAtom = Atom.keepAlive(
  Atom.make((get): Theme =>
    Option.getOrElse(get(chosen), () => AsyncResult.getOrElse(get(recalled), () => 'system')),
  ),
)

/**
 * Adopts a choice: from Settings on this device, or from the Person's settings arriving live.
 * It takes effect at once and is then remembered; a choice that could not be remembered still
 * holds for this run, and the server's copy restores it at the next one.
 */
export const followThemeAtom = Atom.keepAlive(
  Atom.fn(
    Effect.fn('Appearance.follow')(function* (theme: Theme) {
      yield* Effect.sync(() => {
        applyToSystem(theme)
        door.set(chosen, Option.some(theme))
      })
      yield* keep(KEY, theme)
    }),
  ),
)

/**
 * Paints the window behind the app in the palette's own surface, so a keyboard sliding away or a
 * screen being pushed never flashes the wrong color at the edges.
 */
const paintWindow = () => {
  const palette = paletteOf(door.get(themeAtom), Appearance.getColorScheme())
  void SystemUI.setBackgroundColorAsync(nativeTokens[palette]['surface-0'])
}

// The two things that change the palette: the system's own switch (sunset, Control Centre), and
// the Person's choice. Both are subscriptions for the life of the app.
Appearance.addChangeListener(paintWindow)
door.subscribe(themeAtom, paintWindow, { immediate: true })
