import { makeSnapshots, type SnapshotStore } from '@vivid/state'
import { Effect, Option, Predicate, Schema } from 'effect'
import { sessionExpiry } from './account'
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
 *
 * Reading, encoding and writing all happen in programs started on the app's runtime, never in a
 * render or an event handler, and IndexedDB itself does its work off the page's thread.
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

type Doing = SnapshotStoreUnavailable['doing']

/**
 * Whether the store has failed in this page's life. IndexedDB fails in ways that do not mend
 * while a page is open (a private window, a blocked site, a full disk), and each failure costs a
 * round trip that is paid on every write. So the first failure of any kind turns persistence off
 * until the page is loaded again, and the app goes on exactly as it does on a first visit.
 */
let disabled = false

/**
 * One call into IndexedDB that can throw where it stands: `indexedDB.open` in a private window,
 * `transaction` on a database that is closing, `put` on a value it will not clone. The throw
 * becomes the same typed failure a rejected request is.
 */
const calling = <Value>(doing: Doing, call: () => Value) =>
  Effect.try({ try: call, catch: () => new SnapshotStoreUnavailable({ doing }) })

/** Opens the database, making its one store on first use. */
const open = Effect.flatMap(
  calling('open', () => indexedDB.open(DATABASE, 1)),
  (request) =>
    Effect.callback<IDBDatabase, SnapshotStoreUnavailable>((resume) => {
      const refused = () => resume(Effect.fail(new SnapshotStoreUnavailable({ doing: 'open' })))
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE)
        }
      })
      request.addEventListener('error', refused)
      // Another tab holds an older version open and will not let go: the same as a refusal.
      request.addEventListener('blocked', refused)
      request.addEventListener('success', () => resume(Effect.succeed(request.result)))
    }),
)

/**
 * One transaction on the store, and what its request came to. Every failed write fires `abort`,
 * and a failed commit (a full disk) fires only `abort`, so that is what a failure is; `complete`
 * is the only proof a write landed. Both are T3's observations, kept. A failed read fires
 * `error` on the transaction without aborting it in every browser, so that is heard as well.
 */
const within = <Value>(
  doing: Exclude<Doing, 'open'>,
  ask: (store: IDBObjectStore) => IDBRequest<Value>,
) =>
  Effect.gen(function* () {
    const database = yield* open
    const transaction = yield* calling(doing, () =>
      database.transaction(STORE, doing === 'read' ? 'readonly' : 'readwrite'),
    )
    const request = yield* calling(doing, () => ask(transaction.objectStore(STORE)))
    return yield* Effect.callback<Value, SnapshotStoreUnavailable>((resume) => {
      const refused = () => {
        database.close()
        resume(Effect.fail(new SnapshotStoreUnavailable({ doing })))
      }
      transaction.addEventListener('abort', refused)
      transaction.addEventListener('error', refused)
      transaction.addEventListener('complete', () => {
        database.close()
        resume(Effect.succeed(request.result))
      })
    })
  })

/**
 * The one recovery for everything above: a store that has failed is off for the rest of the
 * page's life, and whatever was asked of it answers as an empty store would. A failure here is
 * never drawn and never thrown: keeping a snapshot is a convenience.
 */
const guarded = <Value>(
  program: Effect.Effect<Value, SnapshotStoreUnavailable>,
  otherwise: Value,
): Effect.Effect<Value> =>
  Effect.suspend(() =>
    disabled
      ? Effect.succeed(otherwise)
      : program.pipe(
          Effect.catchTag('SnapshotStoreUnavailable', () =>
            Effect.sync(() => {
              disabled = true
              return otherwise
            }),
          ),
        ),
  )

/** The store as the shared wiring sees it (`SnapshotStore`): it never fails, it only holds nothing. */
const store: SnapshotStore = {
  read: guarded(
    Effect.map(
      within<unknown>('read', (objects) => objects.get(KEY)),
      (value) => (Predicate.isString(value) ? Option.some(value) : Option.none()),
    ),
    Option.none(),
  ),
  write: (text) =>
    guarded(Effect.asVoid(within('write', (objects) => objects.put(text, KEY))), undefined),
  erase: guarded(Effect.asVoid(within('erase', (objects) => objects.delete(KEY))), undefined),
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
  expiry: sessionExpiry,
  now: () => Date.now(),
  launch: start,
})

// A hidden page may never be shown again (the tab is closed, the phone's browser is swiped
// away), so what has changed since the last paced write is written now. T3 flushes the same way
// when its connection drops.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') start(snapshots.flush)
})
