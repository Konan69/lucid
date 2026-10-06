import type { ReactNode } from 'react'
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import {
  closeDrawer,
  DRAWER_SPRING,
  hideKeyboard,
  settleDrawer,
  travel,
  useDrawerOpened,
} from '../data/drawer'
import { useTheme } from '../theme'

/** The drawer leaves a strip of the page showing, so it reads as over the page, not instead of it. */
export const drawerWidth = (screen: number): number => Math.min(Math.round(screen * 0.86), 360)

/** How far a finger travels sideways before the drag is the drawer's and not a tap or a scroll. */
const SIDEWAYS = 14
/** A finger that moves this far up or down first was scrolling, so the drawer lets it go. */
const UPRIGHT = 12
/** A flick this fast (points a second) decides the drawer's direction whatever its position. */
const FLICK = 500

/**
 * The app with a drawer that comes in from the left over it: over the stack and the system's bar,
 * which is why the shell draws it and no screen does (`Shell` in `App.tsx`).
 *
 * It follows the finger on the UI thread: a pan writes `travel` directly, and letting go hands
 * the finger's speed to a spring that finishes the movement, so a slow drag and a flick both end
 * where they were heading. Closed, a rightward drag anywhere on the first screen opens it (an
 * edge-only strip would be Android's own back gesture). On any screen over the first it cannot be
 * reached (`reachable`): there the same drag from the edge is the system's way back. Open, the scrim over the page closes it by tap or
 * by drag; the panel itself takes no drawer gesture, because the Thread rows in it are swiped.
 * Android's back button closes it too (`data/drawer.ts`).
 *
 * The scrim is the theme's `backdrop` and the panel its `drawer` with a `drawer-border` edge,
 * the tokens T3 Code mobile's `src/features/threads/ThreadNavigationSidebar.tsx` paints its
 * sidebar in. The gesture is Vivid's own: the reference's sidebar is a navigator pane.
 *
 * Every callback below is a worklet. They read numbers and shared values only; the keyboard and
 * the open flag are reached through `scheduleOnRN`, never captured.
 */
export function Drawer({
  reachable,
  panel,
  children,
}: {
  /** The first screen is the one in front, so a drag may open the drawer. */
  reachable: boolean
  panel: ReactNode
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  const span = drawerWidth(useWindowDimensions().width)
  const opened = useDrawerOpened()
  const from = useSharedValue(0)

  /** One drag, opening or closing: the same tracking and the same hand-off to the spring. */
  const drag = () =>
    Gesture.Pan()
      .failOffsetY([-UPRIGHT, UPRIGHT])
      .onBegin(() => {
        'worklet'
        // Wherever the panel is right now, mid-spring included: a drag picks it up from there.
        from.value = travel.value
      })
      .onStart(() => {
        'worklet'
        scheduleOnRN(hideKeyboard)
      })
      .onChange((event) => {
        'worklet'
        travel.value = Math.min(1, Math.max(0, from.value + event.translationX / span))
      })
      .onEnd((event) => {
        'worklet'
        const flung = Math.abs(event.velocityX) > FLICK
        const open = flung ? event.velocityX > 0 : travel.value > 0.5
        travel.value = withSpring(open ? 1 : 0, {
          ...DRAWER_SPRING,
          velocity: event.velocityX / span,
        })
        scheduleOnRN(settleDrawer, open)
      })

  const opening = drag()
    .activeOffsetX(SIDEWAYS)
    .enabled(reachable && !opened)
  const closing = Gesture.Exclusive(
    drag().activeOffsetX([-SIDEWAYS, SIDEWAYS]),
    Gesture.Tap().onEnd(() => {
      'worklet'
      scheduleOnRN(closeDrawer)
    }),
  )

  const dimmed = useAnimatedStyle(() => ({ opacity: travel.value }))
  const slid = useAnimatedStyle(() => ({
    transform: [{ translateX: (travel.value - 1) * span }],
    // Fully closed, the panel is off the glass but its shadow would still fall across the edge.
    opacity: travel.value === 0 ? 0 : 1,
  }))

  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={opening}>
        <View
          style={{ flex: 1 }}
          // Under an open drawer the page is not there to a screen reader.
          accessibilityElementsHidden={opened}
          importantForAccessibility={opened ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
      </GestureDetector>
      <GestureDetector gesture={closing}>
        <Animated.View
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          pointerEvents={opened ? 'auto' : 'none'}
          style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop }, dimmed]}
        />
      </GestureDetector>
      <Animated.View
        accessibilityViewIsModal={opened}
        accessibilityElementsHidden={!opened}
        importantForAccessibility={opened ? 'auto' : 'no-hide-descendants'}
        style={[
          {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: span,
            backgroundColor: c.drawer,
            borderRightWidth: 1,
            borderRightColor: c['drawer-border'],
            shadowColor: '#000000',
            // The theme's `drawer-shadow` strength; Android's elevation cannot be tinted, so there
            // the border alone is the edge.
            shadowOpacity: Platform.OS === 'ios' ? 0.32 : 0,
            shadowRadius: 24,
            shadowOffset: { width: 8, height: 0 },
          },
          slid,
        ]}
      >
        {panel}
      </Animated.View>
    </View>
  )
}
