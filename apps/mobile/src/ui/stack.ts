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

/**
 * The bar of Home and a Thread, the two screens with Vivid's capsule in the middle (`VividBar`).
 *
 * The title is empty for good: the capsule floats over the stack in its place
 * (`ui/Presence.tsx`). The centre is the capsule's, so the bar is the system's ordinary
 * `navigator` layout, not `editor`, which stands a title at the leading edge; the reference
 * drops `editor` in the same way wherever it wants a centred title
 * (`SHEET_GLASS_HEADER_OPTIONS`). A screen that draws a plain titled bar on one of these routes
 * (a Thread that is not there) gets that title centred too, on Android only when asked.
 */
export const FRONT_HEADER = {
  ...GLASS_HEADER,
  title: '',
  headerTitleAlign: 'center',
  unstable_navigationItemStyle: undefined,
} satisfies NativeStackNavigationOptions

/**
 * How a Thread arrives beside Home: it fades in. On iOS that takes a little over a fifth of a
 * second; Android has its own fade, 150 ms, and takes no duration from here
 * (react-native-screens `ScreenViewManager.kt`, `setTransitionDuration`).
 *
 * The two screens have the same bar and the same composer in the same places, so a push would
 * slide one copy of each out as the other slid in. A fade leaves them standing and changes only
 * what is between them, which is what happened: the conversation started. The same holds when
 * the drawer swaps Home for a Thread, and when "New thread" goes back.
 */
export const BESIDE = {
  animation: 'fade',
  animationDuration: 220,
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
