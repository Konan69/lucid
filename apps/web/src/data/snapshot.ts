import { makeSnapshots, type SnapshotStore } from '@vivid/state'
import { Effect, Option, Predicate, Schema } from 'effect'
import { start } from './app'
import { live } from './live'
import { engine } from './runtime'
import { appearance } from './vivid'

/**
 * Where this browser keeps the first screen's last answers, so a reload or a cold start draws the
 * Thread list at once and the socket corrects it a moment later. What is kept, the rules for
 * refusing and erasing it, and the pacing of writes are shared with the phone (`@vivid/state`
 * `snapshot.ts`); this is only the browser's store and the moments it flushes.
 *
 * The store is IndexedDB, as in T3 Code (`refs/t3code/apps/web/src/connection/storage.ts`:
 * `openDatabase`, `readDatabaseValue`, `writeDatabaseValue`, `removeDatabaseValue`), not
 * `localStorage`: a Thread list is larger than the few short strings kept there (`kept.ts`), and
 * `localStorage` writes block the page while this must never compete with drawing. The value is
 * JSON text under one key, as T3 stores its snapshots, and is decoded by the shared Schema on
 * the way back in. IndexedDB belongs to the page's origin, so another server's snapshot is never
 * here to begin with; the snapshot names its origin all the same.
 */

const DATABASE = 'vivid'
const STORE = 'snapshot'
const KEY = 'last'

/** The browser's database could not be opened, read or written: blocked, full, or private. */
class SnapshotStoreUnavailable extends Schema.TaggedError<SnapshotStoreUnavailable>()(
  'SnapshotStoreUnavailable',
  { doing: Schema.Literals(['open', 'read', 'write', 'erase'] as const) },
  { title: 'Snapshot store unavailable' },
) {}

/**
 * Opens the database, making its one store on first use. A browser with no IndexedDB (some
 * private modes) throws on the way in, which is the same answer as one that refuses.
 */
const open = Effect.callback<IDBDatabase, SnapshotStoreUnavailable>((resume) => {
  const refused = Effect.fail(new SnapshotStoreUnavailable({ doing: 'open' }))
  const request = Option.liftThrowable(() => indexedDB.open(DATABASE, 1))()
  if (Option.isNone(request)) {
    resume(refused)
    return
  }
  request.value.addEventListener('upgradeneeded', () => {
    if (!request.value.result.objectStoreNames.contains(STORE)) {
      request.value.result.createObjectStore(STORE)
    }
  })
  request.value.addEventListener('error', () => resume(refused))
  request.value.addEventListener('success', () => resume(Effect.succeed(request.value.result)))
})

/**
 * One transaction on the store, and what its request came to. Every failed write fires `abort`,
 * and a failed commit (a full disk) fires only `abort`, so that is what a failure is; `complete`
 * is the only proof a write landed. Both are T3's observations, kept.
 */
const within = <Value>(
  doing: 'read' | 'write' | 'erase',
  ask: (store: IDBObjectStore) => IDBRequest<Value>,
) =>
  Effect.flatMap(open, (database) =>
    Effect.callback<Value, SnapshotStoreUnavailable>((resume) => {
      const transaction = database.transaction(STORE, doing === 'read' ? 'readonly' : 'readwrite')
      const request = ask(transaction.objectStore(STORE))
      transaction.addEventListener('abort', () => {
        database.close()
        resume(Effect.fail(new SnapshotStoreUnavailable({ doing })))
      })
      transaction.addEventListener('complete', () => {
        database.close()
        resume(Effect.succeed(request.result))
      })
    }),
  )

/**
 * The store as the shared wiring sees it: one that cannot be read holds nothing, and one that
 * refuses a write has simply not kept it. Keeping a snapshot is a convenience, and no screen
 * says anything about it.
 */
const store: SnapshotStore = {
  read: within<unknown>('read', (objects) => objects.get(KEY)).pipe(
    Effect.map((value) => (Predicate.isString(value) ? Option.some(value) : Option.none())),
    Effect.catchTag('SnapshotStoreUnavailable', () => Effect.succeed(Option.none<string>())),
  ),
  write: (text) =>
    within('write', (objects) => objects.put(text, KEY)).pipe(
      Effect.asVoid,
      Effect.catchTag('SnapshotStoreUnavailable', () => Effect.void),
    ),
  erase: within('erase', (objects) => objects.delete(KEY)).pipe(
    Effect.asVoid,
    Effect.catchTag('SnapshotStoreUnavailable', () => Effect.void),
  ),
}

export const snapshots = makeSnapshots({
  registry: engine.registry,
  queries: {
    me: live.me,
    threads: live.threads,
    projects: live.projects,
    settings: live.settings,
    appearance,
    notifications: live.notifications,
    drafts: live.drafts,
  },
  store,
  origin: location.origin,
  launch: start,
})

// A hidden page may never be shown again (the tab is closed, the phone's browser is swiped
// away), so what has changed since the last paced write is written now. T3 flushes the same way
// when its connection drops.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') start(snapshots.flush)
})
