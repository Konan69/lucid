import { requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'

interface NativeTokenEvent {
  readonly kind: 'Start' | 'Update'
  readonly token: string
}
interface Awareness {
  addListener(name: 'token', listener: (value: NativeTokenEvent) => void): { remove(): void }
  configure(server: string, token: string): Promise<void>
  updateWidget(snapshot: string): Promise<void>
  /**
   * Starts the one Live Activity if none is up and ends extras; absent in binaries 0.3.20 and older,
   * which only had cards the server started by push.
   */
  arm?(arming: string): Promise<boolean>
  clear(): Promise<void>
}

/** Old binaries and other platforms have no ActivityKit authority. */
export const awareness =
  Platform.OS === 'ios' ? requireOptionalNativeModule<Awareness>('VividAwareness') : null
