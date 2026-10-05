import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native'
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import { Platform } from 'react-native'
import type { Colors } from '../theme'
import { GLASS_SUPPORTED } from './Glass'

/**
 * The native stack's option sets. Every screen transition in the app is the platform's own
 * cross-fade, sheet or modal; nothing here is animated from JavaScript.
 *
 * Ported from T3 Code mobile `src/Stack.tsx` (`GLASS_HEADER_OPTIONS`, `SOLID_HEADER_OPTIONS`,
 * the sheet variants) and
 * `src/native/scrollEdgeEffects.ts` (`nativeHeaderScrollEdgeEffects`). The title's weight is
 * carried by `HEADER_TITLE`, in Vivid's type scale.
 *
 * `unstable_navigationItemStyle`, like the bar's subtitle and an item's `glassEffect`, exists
 * only through the reference's two patches, which Vivid carries too (`patches/` at the repository
 * root): one to `@react-navigation/native-stack`, ported to the pinned 7.19.2, and one to
 * `react-native-screens` 4.26.2, which changes its Objective-C. So these options need a binary
 * built with the patch: app version 0.2.0 and later, which is also the runtime version an
 * over-the-air update is published for.
 */

/** The bar's title: 18 points and heavy, as the reference sets it. */
const HEADER_TITLE = { fontSize: 18, fontWeight: '800' } as const

/**
 * What the system draws where content meets an edge of the screen (iOS 26 and later). Under the
 * bar it is UIKit's own choice, which is the fade that keeps a title readable over rows scrolling
 * beneath it; the other three edges have no bar and get nothing.
 *
 * The reference's `nativeHeaderScrollEdgeEffects`. It answers `automatic` for the top on every
 * platform and version (its note: forcing `soft` made the bar read as a local overlay instead of
 * sampling the content edge to edge), so the value is written out here instead of computed.
 */
const SCROLL_EDGES = {
  top: 'automatic',
  bottom: 'hidden',
  left: 'hidden',
  right: 'hidden',
} as const

/**
 * A transparent bar over a screen whose own content scrolls under it: the system's navigation
 * bar, so on iOS 26 the way back and every bar item are its own liquid-glass buttons. Where the
 * system has no glass the bar is solid and the content is laid out below it instead of under it.
 */
export const GLASS_HEADER = {
  headerShown: true,
  headerBackButtonDisplayMode: 'minimal',
  headerBackTitle: '',
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerTitleStyle: HEADER_TITLE,
  headerTransparent: GLASS_SUPPORTED,
  headerStyle: GLASS_SUPPORTED ? { backgroundColor: 'transparent' } : undefined,
  scrollEdgeEffects: GLASS_SUPPORTED ? SCROLL_EDGES : undefined,
  // UIKit's editor layout: the title stands at the leading edge, beside the way back, and the
  // centre is left free. The reference sets it only where the bar is glass.
  unstable_navigationItemStyle: GLASS_SUPPORTED ? 'editor' : undefined,
} satisfies NativeStackNavigationOptions

/** An opaque bar, for a screen whose content scrolls inside itself and gives glass nothing to sample. */
export const SOLID_HEADER = {
  headerShown: true,
  headerBackButtonDisplayMode: 'minimal',
  headerBackTitle: '',
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerTitleStyle: HEADER_TITLE,
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === 'ios' ? 'editor' : undefined,
} satisfies NativeStackNavigationOptions

/**
 * How one screen replaces another: it fades in where it stands, and nothing travels.
 *
 * Screens used to be pushed (`simple_push` on iOS, the platform's default on Android), so every
 * change of screen slid one over another. The owner asked for no slide anywhere (5 Oct 2026); a
 * cross-fade is what the stack already used for reduced motion, so that is now the one way. It is
 * short: a change of screen happens many times a day, and a long fade would be felt as waiting.
 * The system's back swipe is still the Person's finger moving the screen, which is theirs to do.
 *
 * `animationDuration` is honoured on iOS only (react-native-screens, `fade` among the kinds it
 * applies to); Android fades at the platform's own short length.
 */
export const SCREEN_CHANGE = {
  animation: 'fade',
  animationDuration: 150,
} satisfies NativeStackNavigationOptions

/**
 * The front door's stack still asks for its animation by this name, with whether motion is
 * reduced (`screen/Door.tsx`, which another piece of work is rewriting). The answer no longer
 * depends on that: the door fades as every other screen does. It goes when the door reads
 * `SCREEN_CHANGE` itself.
 */
export const pushAnimation = (_still: boolean): NativeStackNavigationOptions['animation'] =>
  SCREEN_CHANGE.animation

/** A sheet that rests at a little over half the screen and can be pulled nearly full. */
export const SHEET = {
  presentation: 'formSheet',
  // Android's sheet takes its own height; the detents are iOS's.
  sheetAllowedDetents: Platform.OS === 'android' ? undefined : [0.55, 0.92],
} satisfies NativeStackNavigationOptions

/**
 * The navigation container's colours, from the theme in force: what the stack paints behind a
 * screen while it is being pushed, and the ink of any native bar. Both containers (the front
 * door's and the signed-in app's) read it, so a push never flashes another palette.
 */
export const navigationTheme = (c: Colors, dark: boolean): Theme => {
  const base = dark ? DarkTheme : DefaultTheme
  return {
    ...base,
    colors: {
      ...base.colors,
      background: c.screen,
      card: c.screen,
      text: c.foreground,
      primary: c.primary,
      border: c.border,
    },
  }
}
