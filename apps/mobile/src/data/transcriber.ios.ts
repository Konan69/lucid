import AppleTranscription from '@react-native-ai/apple/src/NativeAppleTranscription'
import { Option } from 'effect'

/** iOS's speech-to-text (`transcriber.ts` says why this has a file of its own). */
export const transcriber = Option.some(AppleTranscription)
