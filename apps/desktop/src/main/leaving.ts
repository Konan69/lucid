import { Effect, Option, Schema } from 'effect'
import { ServerSettings } from '../shared/settings.ts'

/**
 * What the app's own document kept in the window's storage for a server the desktop app has just
 * left, and so what is cleared when it leaves.
 *
 * The web app keeps the first screen's last answers in IndexedDB and a Person's drafts and
 * preferences in `localStorage`, both under the server's origin (`apps/web/src/data/snapshot.ts`,
 * `drafts.ts`). "Use a Different Vivid" used to change the origin the window loads and leave all
 * of that on disk under the old one, where it outlived the choice to leave: whoever pointed the
 * app back at that server found the last Person's Thread list drawn before anyone had signed in.
 *
 * These are the storage kinds the app's document writes or could come to write. Cookies are not
 * among them on purpose: Electron clears cookies by registrable domain, not by origin
 * (`Session.clearStorageData` in the installed `electron.d.ts`, the note on `clearData`), so
 * leaving `one.example.com` would sign the app out of `two.example.com` as well. The session
 * with the old server is therefore still the server's to end; the snapshot does not depend on
 * that, because it is gone.
 */
const KEPT_BY_THE_APP = ['indexdb', 'localstorage', 'serviceworkers', 'cachestorage'] as const

/** What `Session.clearStorageData` is asked to clear: one origin's storage, of these kinds. */
export interface StorageToClear {
  readonly origin: string
  readonly storages: Array<(typeof KEPT_BY_THE_APP)[number]>
}

/**
 * What to clear when the server changes from `before` to `after`: the old server's storage, when
 * there was an old server and it is being left. Choosing the same server again leaves nothing
 * behind, so nothing is cleared, and the first choice of a server has nothing to clear.
 */
export const storageLeftBehind = (
  before: ServerSettings,
  after: ServerSettings,
): Option.Option<StorageToClear> =>
  ServerSettings.match(before, {
    NoServer: () => Option.none(),
    Server: ({ origin }) =>
      ServerSettings.guards.Server(after) && after.origin === origin
        ? Option.none()
        : Option.some({ origin, storages: [...KEPT_BY_THE_APP] }),
  })

/** The one thing this needs of an Electron `Session`, so it can be tested without one. */
export interface StorageSession {
  readonly clearStorageData: (options: StorageToClear) => Promise<void>
}

/**
 * Clears what was left behind, through Electron's `Session.clearStorageData`. A clear that fails
 * is not something the Person can act on and must not stop the window loading its new server,
 * so it is said in the log and the program ends without a failure.
 */
export const clearingLeft = (
  left: Option.Option<StorageToClear>,
  session: StorageSession,
): Effect.Effect<void> =>
  Option.match(left, {
    onNone: () => Effect.void,
    onSome: (storage) =>
      Effect.tryPromise({
        try: () => session.clearStorageData(storage),
        catch: () => new StorageNotCleared({}),
      }).pipe(
        Effect.catchTag('StorageNotCleared', () =>
          Effect.logWarning('desktop: the storage of the server that was left was not cleared'),
        ),
      ),
  })

/** The old server's storage could not be cleared. */
class StorageNotCleared extends Schema.TaggedError<StorageNotCleared>()(
  'StorageNotCleared',
  {},
  { title: 'Desktop storage could not be cleared' },
) {}
