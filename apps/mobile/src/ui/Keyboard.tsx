import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardShowing } from '../data/keyboard'
import { useTheme } from '../theme'

/**
 * A screen whose bottom edge rides the keyboard, so a composer or a form's button is never under
 * it. The system moves the content in the keyboard's own animation; nothing here is animated by
 * the app.
 *
 * On Android the padding is applied only while the keyboard is up. That is how the build checked
 * on a device behaved (`VALIDATION.md`: the composer stays above the keyboard and leaves no gap
 * when it goes), so it is kept rather than re-derived without a device to check it on.
 */
export function AboveKeyboard({ children }: { children: ReactNode }) {
  const showing = useKeyboardShowing()
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <KeyboardAvoidingView
      behavior="padding"
      enabled={Platform.OS !== 'android' || showing}
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
