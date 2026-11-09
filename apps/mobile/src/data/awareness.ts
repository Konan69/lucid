import { requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'

export interface NativeTokenEvent {
  readonly kind: 'Start' | 'Update'
  readonly token: string
}
interface Awareness {
  addListener(name: 'token', listener: (value: NativeTokenEvent) => void): { remove(): void }
  configure(server: string, token: string): Promise<void>
  updateWidget(snapshot: string): Promise<void>
  clear(): Promise<void>
}

/** Old binaries and other platforms have no ActivityKit authority. */
export const awareness =
  Platform.OS === 'ios' ? requireOptionalNativeModule<Awareness>('VividAwareness') : null
