import { useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardShowing } from '../data/keyboard'
import { useTheme } from '../theme'
import { GLASS_SUPPORTED } from './Glass'

/**
 * A screen whose bottom edge rides the keyboard, so a composer or a form's button is never under
 * it. The system moves the content in the keyboard's own animation; nothing here is animated by
 * the app.
 *
 * On Android the padding is applied only while the keyboard is up. That is how the build checked
 * on a device behaved (`VALIDATION.md`: the composer stays above the keyboard and leaves no gap
 * when it goes), so it is kept rather than re-derived without a device to check it on.
 *
 * This one is for a screen that starts at the top of the window: one with no bar (Home, the
 * front door), a sheet, or anything under a transparent bar.
 */
export function AboveKeyboard({ children }: { children: ReactNode }) {
  return <Riding offset={0}>{children}</Riding>
}

/**
 * Whether a solid system bar pushes a screen down the window. Only iOS without glass: with glass
 * the bar is transparent and the screen starts at the top, and Android resizes the window for
 * the keyboard itself (`softwareKeyboardLayoutMode: resize`), so nothing is left to make up.
 */
const BAR_PUSHES_DOWN = Platform.OS === 'ios' && !GLASS_SUPPORTED

/**
 * The same, for a screen that has the system's bar above it (a Thread).
 *
 * `KeyboardAvoidingView` works out how far the keyboard covers it from its own frame, and takes
 * that frame to start at the top of the window. Under a solid bar the screen starts lower by the
 * bar's height, so the padding came up short by exactly that and the composer stayed partly
 * under the keyboard. `keyboardVerticalOffset` is the view's distance from the top of the window.
 *
 * That distance is measured, not looked up: the screen reaches the bottom of the window, so it
 * is the window's height less the screen's own, read when the screen is laid out. The stack's own
 * number is only offered as an animated value (`useAnimatedHeaderHeight`), and the hook that
 * gives it as a number lives in a package this app does not depend on. T3 Code mobile gets the
 * same result from `react-native-keyboard-controller` (`automaticOffset`), a native module Vivid
 * does not ship.
 */
export function AboveKeyboardBelowBar({ children }: { children: ReactNode }) {
  const window = useWindowDimensions().height
  // The screen's height with no keyboard padding: padding shrinks the content, not this frame.
  const [height, setHeight] = useState(window)
  if (!BAR_PUSHES_DOWN) return <Riding offset={0}>{children}</Riding>
  return (
    <Riding offset={Math.max(0, window - height)} onHeight={setHeight}>
      {children}
    </Riding>
  )
}

function Riding({
  offset,
  onHeight,
  children,
}: {
  offset: number
  onHeight?: (height: number) => void
  children: ReactNode
}) {
  const showing = useKeyboardShowing()
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <KeyboardAvoidingView
      behavior="padding"
      enabled={Platform.OS !== 'android' || showing}
      keyboardVerticalOffset={offset}
      onLayout={
        onHeight === undefined ? undefined : (event) => onHeight(event.nativeEvent.layout.height)
      }
      style={{ flex: 1, backgroundColor: c.screen }}
    >
      {/* Clear of a notch or a rounded corner at the sides, as `Screen` is. It is a view of its
          own because the outer one's padding is the keyboard's to set. */}
      <View style={{ flex: 1, paddingLeft: insets.left, paddingRight: insets.right }}>
        {children}
      </View>
    </KeyboardAvoidingView>
  )
}
