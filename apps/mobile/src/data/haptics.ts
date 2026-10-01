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

/** Something was sent or committed: a message, a Routine run, a swipe that lands. */
export const commit = () => {
  if (onDevice) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
}

/** A consequential yes: allowing an action, signing a device in. */
export const confirm = () => {
  if (onDevice) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
}

/** Something destructive or refused: deleting, denying, a change the server would not take. */
export const warn = () => {
  if (onDevice) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
}
