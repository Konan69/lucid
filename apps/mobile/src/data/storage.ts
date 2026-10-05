import { Effect, Option, Schema } from 'effect'
import { File, Paths } from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

/**
 * What this device keeps between runs: a few short strings, under the operating system's own
 * protected store (the Keychain on iOS, the Keystore on Android). The browser preview has no such
 * store and uses `localStorage`, which is why nothing secret is ever handed to it there; see
 * `session.ts`.
 *
 * `expo-secure-store` and `localStorage` only speak Promises and exceptions, so this is the one
 * place they are wrapped. Everything above it is an Effect with a typed failure.
 */

/** The device's store could not be read or written: locked, full, or missing on this platform. */
export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  'StorageUnavailable',
  { message: Schema.String },
  { title: 'Device storage unavailable' },
) {}

const UNREADABLE = 'This device could not read what it had saved.'
const UNWRITABLE = 'This device could not save that. Try again.'

const onDevice = Platform.OS !== 'web'

/** What is kept under a key, when something is. */
export const recall = Effect.fn('Storage.recall')(function* (key: string) {
  const kept = yield* Effect.tryPromise({
    try: () =>
      onDevice ? SecureStore.getItemAsync(key) : Promise.resolve(localStorage.getItem(key)),
    catch: () => new StorageUnavailable({ message: UNREADABLE }),
  })
  return Option.fromNullOr(kept)
})

/** Keeps a value under a key, replacing whatever was there. */
export const keep = Effect.fn('Storage.keep')(function* (key: string, value: string) {
  yield* Effect.tryPromise({
    try: () =>
      onDevice
        ? SecureStore.setItemAsync(key, value)
        : Promise.resolve(localStorage.setItem(key, value)),
    catch: () => new StorageUnavailable({ message: UNWRITABLE }),
  })
})

/**
 * What is kept in a file of the app's own, for things too long for the protected store. That
 * store is for a few short secrets (a session, a server address) and the platforms do not promise
 * it will take more: a Person's unsent drafts can run to pages. The app's documents are private
 * to the app, which is as private as words the Person has typed and not sent need to be.
 */
export const recallFile = Effect.fn('Storage.recallFile')(function* (name: string) {
  const kept = yield* Effect.tryPromise({
    try: async () => {
      if (!onDevice) return localStorage.getItem(name)
      const file = new File(Paths.document, name)
      return file.exists ? await file.text() : null
    },
    catch: () => new StorageUnavailable({ message: UNREADABLE }),
  })
  return Option.fromNullOr(kept)
})

/** Keeps a value in a file of the app's own, replacing whatever was there. */
export const keepFile = Effect.fn('Storage.keepFile')(function* (name: string, value: string) {
  yield* Effect.try({
    try: () => {
      if (!onDevice) {
        localStorage.setItem(name, value)
        return
      }
      const file = new File(Paths.document, name)
      if (!file.exists) file.create()
      file.write(value)
    },
    catch: () => new StorageUnavailable({ message: UNWRITABLE }),
  })
})

/** Removes a file of the app's own. One that is not there is already removed. */
export const forgetFile = Effect.fn('Storage.forgetFile')(function* (name: string) {
  yield* Effect.try({
    try: () => {
      if (!onDevice) {
        localStorage.removeItem(name)
        return
      }
      const file = new File(Paths.document, name)
      if (file.exists) file.delete()
    },
    catch: () => new StorageUnavailable({ message: UNWRITABLE }),
  })
})
