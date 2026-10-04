import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native'
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import { Platform } from 'react-native'
import type { Colors } from '../theme'
import { GLASS_SUPPORTED } from './Glass'

/**
 * The native stack's option sets. Every screen transition in the app is the platform's own push,
 * pop, sheet or modal; nothing here is animated from JavaScript.
 *
 * Ported from T3 Code mobile `src/Stack.tsx` (`GLASS_HEADER_OPTIONS`, `SOLID_HEADER_OPTIONS`,
 * the sheet variants, and the `simple_push` note beside its root navigator) and
 * `src/native/scrollEdgeEffects.ts` (`nativeHeaderScrollEdgeEffects`). Two things differ:
 * - `unstable_navigationItemStyle: 'editor'` is left out. The reference gets it from its patches
 *   to `@react-navigation/native-stack` and to the Objective-C of `react-native-screens`
 *   (`RNSScreenStackHeaderConfig.mm`); Vivid's pinned, unpatched packages have no such option, and
 *   a native change cannot reach an installed app over the air.
 * - The title's weight is carried by `HEADER_TITLE`, in Vivid's type scale.
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
} satisfies NativeStackNavigationOptions

/**
 * How one screen replaces another. iOS uses `simple_push`: the platform's push and its back
 * swipe, without the cast shadow and the native bar transition that fight a transparent bar.
 * Android keeps its default. With reduced motion the screens cross-fade and nothing travels.
 */
export const pushAnimation = (still: boolean): NativeStackNavigationOptions['animation'] => {
  if (still) return 'fade'
  return Platform.OS === 'ios' ? 'simple_push' : 'default'
}

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
