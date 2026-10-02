import type { ReactNode } from 'react'
import { View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { useTheme } from '../theme'
import { GUTTER, IconButton, Label, type Tone } from './ui'

/**
 * The bar at the top of every screen: the way back, what this is, and at most a couple of
 * actions. It is drawn by the app on both platforms, so a Thread's title (which is live) and the
 * tokens it is painted in never have to be pushed into a native bar after render. The system's
 * back swipe is the stack's and works whether or not this bar is shown.
 *
 * - `leading` stands before the title: Vivid's face, on the screens where Vivid is at work.
 * - `subtitleTone` is the ink the line under the title is said in. That line can be a state
 *   (working, waiting for the Person), and a state is said in its own colour as well as in words.
 */
export function Header({
  title,
  subtitle,
  subtitleTone = 'ink-3',
  leading,
  onBack,
  trailing,
}: {
  title: string
  subtitle?: string
  subtitleTone?: Tone
  leading?: ReactNode
  onBack?: () => void
  trailing?: ReactNode
}) {
  const insets = useSafeAreaInsets()
  const { colors: c } = useTheme()
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: c['surface-0'] }}>
      <View
        style={{
          minHeight: m['topbar-h'] + 4,
          flexDirection: 'row',
          alignItems: 'center',
          // The chevron is drawn in the middle of a 44-point target, about 19 points in from the
          // target's edge. Two points of padding put its drawn edge on the gutter the page's
          // text starts at, which is what makes the bar and the page read as one column.
          paddingLeft: onBack === undefined ? GUTTER : 2,
          paddingRight: trailing === undefined ? GUTTER : 6,
        }}
      >
        {onBack !== undefined && (
          <IconButton icon={ChevronLeft} label="Back" tone="ink" onPress={onBack} />
        )}
        {leading !== undefined && (
          <View style={{ marginLeft: onBack === undefined ? 0 : 2, marginRight: 10 }}>
            {leading}
          </View>
        )}
        <View
          style={{
            flex: 1,
            minWidth: 0,
            // What stands before the title already keeps it clear of the way back.
            marginLeft: onBack === undefined || leading !== undefined ? 0 : 2,
          }}
        >
          <Label accessibilityRole="header" numberOfLines={1} size="headline">
            {title}
          </Label>
          {subtitle !== undefined && (
            // Said again to a screen reader when it changes: it is where a Thread says that
            // Vivid has started working, or is now waiting for the Person.
            <Label
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              size="caption"
              tone={subtitleTone}
            >
              {subtitle}
            </Label>
          )}
        </View>
        {trailing !== undefined && (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>{trailing}</View>
        )}
      </View>
    </View>
  )
}

/**
 * A screen's ground: the palette's own surface from edge to edge, with what is drawn on it kept
 * clear of a notch or a rounded corner at the sides. Upright, those insets are nothing; with the
 * phone on its side they are what keeps a row's first letters out from under the camera.
 */
export function Screen({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        flex: 1,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: c['surface-0'],
      }}
    >
      {children}
    </View>
  )
}
