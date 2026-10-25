import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID, type EntryId } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { Cause, Effect, Exit, Fiber, Schema } from 'effect'
import * as Pg from 'pg'
import { runtimeProcess } from '../../tests/child.ts'
import { databaseConfigured, disposableDatabase } from '../../tests/database.ts'
import { dropControl, query, storesOn } from '../../tests/stores.ts'
import { PooledDatabase } from './driver.ts'
import { ControlLost, RuntimeOwned } from './errors.ts'

const context = BACKGROUND_CONTEXT
const ROOT = ROOT_CONVERSATION_ID
const ada = PersonId.make('person-ada')

/** The rejection a Promise ends with, for asserting on its tag. */
const refusal = <A>(attempt: () => Promise<A>) =>
  Effect.promise(() =>
    attempt().then(
      () => ({ refused: false, tag: 'none' }),
      (cause: { readonly _tag?: string }) => ({
        refused: true,
        tag: cause._tag === undefined ? 'untagged' : cause._tag,
      }),
    ),
  )

/** The owner row as it stands: which generation and which process hold the conversations. */
const owner = (database: string) =>
  query(database, 'SELECT generation::text AS generation, process FROM runtime.owner').pipe(
    Effect.map((rows) => ({
      generation: String(rows[0] === undefined ? '' : rows[0]['generation']),
      process: String(rows[0] === undefined ? '' : rows[0]['process']),
    })),
  )

/** A pool of the test's own on the database, ended with the scope. */
const poolOn = (database: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Pg.Pool({ connectionString: database, max: 2 })),
    (pool) => Effect.promise(() => pool.end()),
  )

/** SQLSTATE 55P03, lock_not_available: what `NOWAIT` answers when another transaction holds the row. */
const isLockNotAvailable = Schema.is(Schema.Struct({ code: Schema.Literal('55P03') }))

/**
 * Ask, from a transaction of the case's own, for the owner row's update lock without waiting,
 * then roll back whatever the answer. A takeover's UPDATE needs that lock. `held` is PostgreSQL's
 * refusal (55P03): another transaction holds the row, here the paused write's `FOR SHARE`.
 * `free` means nothing holds it, so a takeover would not wait for the write.
 */
const ownerRowLock = Effect.fn('FenceTest.ownerRowLock')(function* (database: string) {
  const client = yield* Effect.acquireRelease(
    Effect.promise(() => {
      const opened = new Pg.Client({ connectionString: database })
      return opened.connect().then(() => opened)
    }),
    (opened) => Effect.promise(() => opened.query('ROLLBACK').finally(() => opened.end())),
  )
  yield* Effect.promise(() => client.query('BEGIN'))
  return yield* Effect.promise(() =>
    client.query('SELECT id FROM runtime.owner WHERE id = 1 FOR UPDATE NOWAIT').then(
      () => 'free' as const,
      (cause: unknown) => (isLockNotAvailable(cause) ? ('held' as const) : Promise.reject(cause)),
    ),
  )
}, Effect.scoped)

/** A notes directory the child runtime needs to start, removed with the scope. */
const notesDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-fence-'))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
)

describe.skipIf(!databaseConfigured)('the runtime’s authority over the stores', () => {
  it.effect('does not start a second runtime while the first holds the lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* disposableDatabase()
        yield* storesOn(database)
        const second = yield* Effect.exit(Effect.scoped(storesOn(database)))
        expect(Exit.isFailure(second)).toBe(true)
        if (Exit.isFailure(second)) expect(Cause.squash(second.cause)).toBeInstanceOf(RuntimeOwned)
        // The first runtime's generation is still the one on record.
        expect((yield* owner(database)).generation).toBe('1')
      }),
    ),
  )

  it.live(
    'holds a takeover behind a write in the fence, then refuses the old runtime',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* disposableDatabase()
          // Everything below is released by this case's scope, whatever fails: the old runtime,
          // the successor process, the test's pool and the paused write (released first).
          const old = yield* storesOn(database)
          const store = yield* old.open(ada)
          // A second store opened before the takeover and never asked for an id yet.
          const idle = yield* old.open(PersonId.make('person-grace'))
          yield* Effect.promise(() =>
            store.commit([{ type: 'conversation', value: { id: ROOT } }], context),
          )
          const entry = yield* Effect.promise(() => store.mintId<EntryId>())

          // A write of the old generation, paused inside its transaction: the fence is held.
          const authority = yield* owner(database)
          const writer = new PooledDatabase(yield* poolOn(database), authority)
          // The driver's callback is a Promise; the case signals it with events, not timers.
          const signals = new NodeEvents.EventEmitter()
          const entered = NodeEvents.EventEmitter.once(signals, 'entered')
          const released = NodeEvents.EventEmitter.once(signals, 'released')
          const inFlight = writer.write([], () => {
            signals.emit('entered')
            return released.then(() => ({
              value: 'committed',
              statements: [
                {
                  recordKind: 'metadata' as const,
                  sql: "INSERT INTO runtime.stores (id, person_id) VALUES (gen_random_uuid(), 'person-in-flight')",
                  params: [],
                },
              ],
            }))
          })
          // Registered before anything can fail: the paused write is let go and settles before
          // the pool it holds a connection of is ended.
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => {
              signals.emit('released')
              return inFlight.then(
                () => {},
                () => {},
              )
            }),
          )
          yield* Effect.promise(() => entered)

          // The old runtime's control connection dies; it is told.
          yield* dropControl(database)
          expect(yield* Effect.flip(old.lost)).toBeInstanceOf(ControlLost)

          // The paused write holds the owner row: a transaction that wants it for update, as a
          // takeover does, is refused at once.
          expect(yield* ownerRowLock(database)).toBe('held')

          // A new runtime, its own operating-system process, takes the lock and asks for the
          // owner row, which it cannot have until the write ends.
          const notes = yield* notesDirectory
          const successor = yield* runtimeProcess({ database, notes })
          const listened = yield* Effect.forkChild(successor.listening)

          // The write that held the fence commits under the generation it checked; only then
          // does the successor finish taking over.
          signals.emit('released')
          expect(yield* Effect.promise(() => inFlight)).toBe('committed')
          yield* Fiber.join(listened)
          const after = yield* owner(database)
          expect(BigInt(after.generation)).toBe(BigInt(authority.generation) + 1n)
          expect(after.process).not.toBe(authority.process)
          expect(
            yield* query(
              database,
              "SELECT 1 FROM runtime.stores WHERE person_id = 'person-in-flight'",
            ),
          ).toHaveLength(1)

          // Everything the old runtime still holds is refused, with nothing written.
          expect(
            yield* refusal(() =>
              writer.write([], () => Promise.resolve({ value: undefined, statements: [] })),
            ),
          ).toEqual({ refused: true, tag: 'OwnershipLost' })
          expect(
            yield* refusal(() =>
              store.commit(
                [{ type: 'entry', value: { id: entry, conversationId: ROOT, kind: 'stale' } }],
                context,
              ),
            ),
          ).toEqual({ refused: true, tag: 'OwnershipLost' })
          expect(yield* Effect.promise(() => store.entry(entry, context))).toBeUndefined()
          expect(yield* refusal(() => idle.mintId<EntryId>())).toEqual({
            refused: true,
            tag: 'OwnershipLost',
          })
          const making = yield* Effect.exit(old.open(PersonId.make('person-new')))
          expect(Exit.isFailure(making)).toBe(true)
        }),
      ),
    60_000,
  )

  it.live(
    'ends the runtime process when its control connection is lost, and frees the lock',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* disposableDatabase()
          const notes = yield* notesDirectory
          const runtime = yield* runtimeProcess({ database, notes })
          yield* runtime.listening
          const held = yield* owner(database)
          yield* dropControl(database)
          const code = yield* runtime.exit
          expect(code).not.toBe(0)
          expect(runtime.output()).toContain('ControlLost')
          // A successor takes over at once: the lock went with the connection.
          yield* storesOn(database)
          expect(BigInt((yield* owner(database)).generation)).toBe(BigInt(held.generation) + 1n)
        }),
      ),
    60_000,
  )
})
