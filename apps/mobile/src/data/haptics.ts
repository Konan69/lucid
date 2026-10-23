import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

/**
 * The few moments the phone answers with touch. Each is fired at the moment the Person commits,
 * never when a result arrives later and never more than once per action, and each is paired with
 * something visible: haptics are off for many people and absent on much hardware.
 *
 * The browser preview has no haptic engine, so nothing is asked of it there.
 */

const onDevice = Platform.OS !== 'web'

/** A choice among a few moved: the workspace, a segment, a checkbox. */
export const tick = () => {
  if (onDevice) void Haptics.selectionAsync()
}

/** Something was sent or committed: a message, a choice, a swipe that lands. */
export const commit = () => {
  if (onDevice) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
}

/**
 * A long press was held long enough to open its menu. Android only: there the app opens the menu
 * itself (`t3/Menu.tsx`), and the platform's own long-press tick is what every other menu on the
 * phone gives, following the Person's own touch-feedback setting. On iOS the system opens the
 * menu and answers the hold itself; saying it here too would be felt twice.
 */
export const hold = () => {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Long_Press)
  }
}

/** A consequential yes: allowing an action, signing a device in. */
export const confirm = () => {
  if (onDevice) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
}

/** Something destructive or refused: deleting, denying, a change the server would not take. */
export const warn = () => {
  if (onDevice) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
}
