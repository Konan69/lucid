import type AppleTranscription from '@react-native-ai/apple/src/NativeAppleTranscription'
import { Option } from 'effect'

/**
 * The system's speech-to-text, where the phone has one Vivid can use: iOS's, in `transcriber.ios.ts`.
 * Everywhere else there is none, and the module is never imported: its spec asks the registry for
 * `NativeAppleTranscription` with `getEnforcing` as it loads, which throws in a binary that has no
 * such module, so importing it on Android stopped the app before its first screen (seen on the
 * Android emulator, 27 October 2026).
 */
export const transcriber: Option.Option<typeof AppleTranscription> = Option.none()
