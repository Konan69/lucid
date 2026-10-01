import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform } from 'react-native'
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
  return (
    <KeyboardAvoidingView
      behavior="padding"
      enabled={Platform.OS !== 'android' || showing}
      style={{ flex: 1, backgroundColor: c['surface-0'] }}
    >
      {children}
    </KeyboardAvoidingView>
  )
}
