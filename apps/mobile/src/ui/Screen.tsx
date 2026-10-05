import type { ReactNode } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme'

/**
 * A screen's ground: the palette's own surface from edge to edge, with what is drawn on it kept
 * clear of a notch or a rounded corner at the sides. Upright, those insets are nothing; with the
 * phone on its side they are what keeps a row's first letters out from under the camera.
 *
 * The bar above it is the system's (`ui/Bar.tsx`, `ui/stack.ts`), so nothing is drawn for it
 * here. `collapsable={false}` keeps this view in the native tree, as T3 Code mobile's screens do
 * around their scroll view (`src/features/settings/SettingsRouteScreen.tsx`): the scroller under
 * it is what UIKit insets beneath a glass bar and samples for the bar's edge effect.
 */
export function Screen({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      collapsable={false}
      style={{
        flex: 1,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: c.screen,
      }}
    >
      {children}
    </View>
  )
}
