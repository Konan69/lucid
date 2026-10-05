import type { SnapshotStore } from '@vivid/state'
import { Effect, Option } from 'effect'
import { forgetFile, keepFile, recallFile } from './storage'

/**
 * Where this phone keeps the first screen's last answers, so opening the app draws Home and the
 * Thread list at once and the socket corrects them a moment later. What is kept, the rules for
 * refusing and erasing it, and the pacing of writes are shared with the web (`@vivid/state`
 * `snapshot.ts`, ported from T3 Code); this is only the phone's store.
 *
 * It is a file of the app's own (`storage.ts`), like the drafts: the protected store is for a
 * few short secrets, and nothing in a snapshot is one. The app's documents are private to the
 * app. One read at launch and one paced write of some kilobytes do not need a database, so no
 * native module is added for it.
 */

const FILE = 'snapshot.json'

/**
 * The store as the shared wiring sees it: one that cannot be read holds nothing, and one that
 * refuses a write has simply not kept it. Keeping a snapshot is a convenience, and no screen
 * says anything about it.
 */
export const snapshotStore: SnapshotStore = {
  read: recallFile(FILE).pipe(
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  ),
  write: (text) =>
    keepFile(FILE, text).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void)),
  erase: forgetFile(FILE).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void)),
}
