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
export const SCROLL_EDGES = {
  top: 'automatic',
  bottom: 'hidden',
  left: 'hidden',
  right: 'hidden',
} as const

/**
 * No edge effect at all, for a Thread's conversation, which is laid out under the bar and never
 * behind it, so there is no edge for the system to soften.
 *
 * It was written for the conversation when that was an upside-down list. The system gives the
 * effect to a scroll view's own top edge, and a list turned over has its top at the foot of the
 * screen: the owner's iPhone showed the whole conversation blurred (5 to 8 October 2026, iOS 26,
 * app 0.2.0). Asking for this through the screen did not stop it on his phone, though the
 * library's code says it should have: it is applied when the option's value changes and when the
 * screen is put in its stack, to the scroll view on the screen's first-child chain at that moment
 * (`RNSScreen.mm`, `updateContentScrollViewEdgeEffectsIfExists`; `RNSScrollViewFinder`). So the
 * conversation is no longer turned over (`Transcript`, `screen/Chat.tsx`), and this stays as what
 * a scroller under the bar should have. Not seen on an iPhone from here.
 */
export const NO_SCROLL_EDGES = {
  top: 'hidden',
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

/**
 * How round the top of a fitted sheet is on Android, in points. The library's own value there is
 * none at all (`Screen.sheetCornerRadius` starts at 0 and a negative one is read as 0,
 * `ScreenStackFragment.attachShapeToScreen`), which draws a square slab. iOS is left to the
 * system, whose sheet has its own corners.
 */
const SHEET_CORNERS = 28

/**
 * A bottom sheet as tall as what it holds: a short form or a few choices about one thing, over
 * the page the Person was on. It is the platform's own sheet, a `UISheetPresentationController`
 * on iOS and react-native-screens' Material bottom sheet on Android, so the grabber, the swipe
 * down, the tap on the dimmed page and Android's back all close it, and none of that is written
 * here. What T3 Code mobile's form sheets are (`src/Stack.tsx`, every
 * `...FORM_SHEET_PRESENTATION_OPTIONS` screen), with the height taken from the content instead of
 * a fraction of the screen.
 *
 * A route that takes these options spreads them after the stack's own, because it has to undo
 * two of those:
 *
 * - `headerShown: false`. An Android form sheet cannot host the stack's bar, and a sheet this
 *   small has no room for one: its title is the first line of its own content
 *   (`FittedSheet`, `ui/Sheet.tsx`).
 * - `animation: 'default'`, in place of the stack's cross-fade (`SCREEN_CHANGE`). Read in
 *   react-native-screens 4.26.2: on iOS `fade` sets the presented controller's
 *   `modalTransitionStyle` to a cross-dissolve (`RNSScreen.mm`, `setStackAnimation`), so the
 *   sheet would fade in where it rests instead of rising, while `default` touches nothing and
 *   leaves UIKit's own sheet motion. On Android the value is not read for a form sheet at all:
 *   its fragment answers `onCreateAnimator` with the sheet's own enter and exit
 *   (`ScreenStackFragment.kt`), whatever the transaction was told. The duration is the stack
 *   animator's and is cleared with it.
 *
 * `fitToContents` measures the content, so the screen's root must have a height of its own and
 * never `flex: 1` (the library lays the content out with no bottom edge for exactly this:
 * `ScreenStackItem.tsx`, `absoluteWithNoBottom`). It is iOS 16's: on iOS 15 the library logs that it
 * is unsupported and the sheet keeps the system's height (`updateFormSheetPresentationStyle`).
 * The grabber is iOS's (`sheetGrabberVisible` is not read on Android), so `FittedSheet` draws
 * Android's handle itself.
 */
export const FITTED_SHEET = {
  presentation: 'formSheet',
  headerShown: false,
  animation: 'default',
  animationDuration: undefined,
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: Platform.OS === 'android' ? SHEET_CORNERS : undefined,
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
