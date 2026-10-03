import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import { Platform } from 'react-native'
import { GLASS_SUPPORTED } from './Glass'

/**
 * The native stack's option sets. Every screen transition in the app is the platform's own push,
 * pop, sheet or modal; nothing here is animated from JavaScript.
 *
 * Ported from T3 Code mobile `src/Stack.tsx` (`GLASS_HEADER_OPTIONS`, `SOLID_HEADER_OPTIONS`,
 * the sheet variants, and the `simple_push` note beside its root navigator). Two things differ:
 * - `unstable_navigationItemStyle: 'editor'` is left out. The pinned
 *   `@react-navigation/native-stack` has no such option.
 * - The title's weight is carried by `HEADER_TITLE`, in Vivid's type scale.
 */

/** The bar's title: 18 points and heavy, as the reference sets it. */
const HEADER_TITLE = { fontSize: 18, fontWeight: '800' } as const

/**
 * A transparent bar over a screen whose own content scrolls under it. Where the system has no
 * glass the bar is solid and the content is laid out below it instead of under it.
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
