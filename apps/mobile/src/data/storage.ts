import { Effect, Option, Schema } from 'effect'
import { File, Paths } from 'expo-file-system'
import { writeAsStringAsync } from 'expo-file-system/legacy'
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

const UNREADABLE = 'This device couldn’t read its saved data.'
export const UNWRITABLE = 'This device could not save that. Try again.'

const onDevice = Platform.OS !== 'web'

/**
 * Reads at once when the store can, and by its asynchronous call when it cannot.
 *
 * Everything the app opens on is read here at launch: the session, the theme, the server's last
 * answers, where the Person was and what their Threads last said. Read asynchronously, each
 * answered a turn or more after the first screen was drawn, so every launch drew an empty screen
 * first and the real one a moment later, which reads as a flash. Both stores have a synchronous
 * read (`SecureStore.getItem`, `File.textSync`); with it the answers are there before the first
 * screen is drawn, and the app opens straight onto what it kept. They are a few short strings
 * and files of some hundred kilobytes at most.
 *
 * The asynchronous call stays as the way back: an installed binary older than this JavaScript may
 * not have the synchronous one, and reading late is better than reading nothing.
 */
const read = (
  now: () => string | null,
  later: () => Promise<string | null>,
): Effect.Effect<Option.Option<string>, StorageUnavailable> =>
  Effect.try({ try: now, catch: () => new StorageUnavailable({ message: UNREADABLE }) }).pipe(
    Effect.catchTag('StorageUnavailable', () =>
      Effect.tryPromise({
        try: later,
        catch: () => new StorageUnavailable({ message: UNREADABLE }),
      }),
    ),
    Effect.map(Option.fromNullOr),
  )

/** What is kept under a key, when something is. */
export const recall = Effect.fn('Storage.recall')((key: string) =>
  onDevice
    ? read(
        () => SecureStore.getItem(key),
        () => SecureStore.getItemAsync(key),
      )
    : read(
        () => localStorage.getItem(key),
        () => Promise.resolve(localStorage.getItem(key)),
      ),
)

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
export const recallFile = Effect.fn('Storage.recallFile')((name: string) => {
  if (!onDevice) {
    return read(
      () => localStorage.getItem(name),
      () => Promise.resolve(localStorage.getItem(name)),
    )
  }
  return read(
    () => {
      const file = new File(Paths.document, name)
      return file.exists ? file.textSync() : null
    },
    () => {
      const file = new File(Paths.document, name)
      return file.exists ? file.text() : Promise.resolve(null)
    },
  )
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

/**
 * Keeps a value in a file of the app's own without holding the app up while it is written.
 *
 * `keepFile` writes through `File.write`, which the installed expo-file-system (57.0.7) does on
 * the JavaScript thread: right for a draft, which is a few words and must be down before the app
 * can be closed, and wrong for something the size of a snapshot written while a list is being
 * scrolled. The same package's `expo-file-system/legacy` entry has the one write that is handed
 * to the native side and answered later (`writeAsStringAsync`,
 * `build/legacy/FileSystem.d.ts`); it is part of the module already in the app's binary.
 */
export const keepFileAside = Effect.fn('Storage.keepFileAside')(function* (
  name: string,
  value: string,
) {
  yield* Effect.tryPromise({
    try: () => {
      if (!onDevice) {
        localStorage.setItem(name, value)
        return Promise.resolve()
      }
      return writeAsStringAsync(new File(Paths.document, name).uri, value)
    },
    catch: () => new StorageUnavailable({ message: UNWRITABLE }),
  })
})
