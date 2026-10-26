import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import type { Storage } from '@earendil-works/pi-durable'
import { RuntimePersonId, type PersonId } from '@vivid/contracts'
import { Context, Deferred, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { Client, Pool } from 'pg'
import { RuntimeSettings } from '../settings.ts'
import type { Database } from './database.ts'
import { PooledDatabase, type Authority } from './driver.ts'
import {
  ConnectionSettingInvalid,
  ControlLost,
  MigrationsPending,
  RuntimeOwned,
  StoreUnavailable,
} from './errors.ts'
import { LEDGER } from './ledger.ts'
import { PostgresStore, StoreId } from './store.ts'

/**
 * How many pooled connections the stores share. Every Person's store borrows one per read or per
 * write transaction and holds none in between, so this bounds concurrent SQL, not Persons. The
 * control connection is separate: the runtime uses at most `POOL + 1` connections.
 */
export const POOL = 10

export interface StoresService {
  /** Open a Person's store, making it the first time that Person is seen. */
  readonly open: (personId: PersonId) => Effect.Effect<Storage, StoreUnavailable>
  /**
   * The Persons whose stores hold unfinished work: a task that is not terminal, or a submission
   * still queued. These are what a restart must open and resume; nothing else is opened until a
   * request asks for it.
   */
  readonly working: Effect.Effect<ReadonlyArray<PersonId>, StoreUnavailable>
  /** Fails once the control connection is gone; it never succeeds. */
  readonly lost: Effect.Effect<never, ControlLost>
}

/**
 * Every Person's conversation store, in the shared PostgreSQL tables, and the authority to write
 * them.
 *
 * The runtime is one process that owns every store, as Pi requires of each ("One process owns a
 * storage at a time", Pi README, Storage). On start it takes, on a connection of its own, a
 * session advisory lock for the whole runtime and then advances the owner row's generation;
 * every write after that is fenced by that generation (`driver.ts`). The pattern is Temporal's
 * shard `range_id` and Mastra's run fence: the lock keeps a second runtime from starting while
 * this one lives, and the generation keeps a runtime that has lost its lock from writing once a
 * successor has taken over. A takeover waits for the writes that already hold the fence.
 */
export class Stores extends Context.Service<Stores, StoresService>()('vivid/Runtime/Stores') {}

/**
 * The advisory lock's key: the first eight bytes of SHA-256 of a fixed name, read as a signed
 * 64-bit integer, which is the key space of `pg_try_advisory_lock(bigint)`. It is computed, not
 * chosen, so it cannot collide by accident with a key another part of the product picks.
 */
const LOCK = NodeCrypto.createHash('sha256')
  .update('@vivid/agent-runtime/conversations', 'utf8')
  .digest()
  .readBigInt64BE()
  .toString()

const decodeSettings = Schema.decodeUnknownEffect(
  Schema.Struct({ client_encoding: Schema.String, standard_conforming_strings: Schema.String }),
)
const decodeClaim = Schema.decodeUnknownEffect(Schema.Struct({ owned: Schema.Boolean }))
const decodePresent = Schema.decodeUnknownEffect(Schema.Struct({ present: Schema.Boolean }))
const decodeGeneration = Schema.decodeUnknownEffect(Schema.Struct({ generation: Schema.String }))
const decodeStore = Schema.decodeUnknownEffect(Schema.Struct({ id: StoreId }))
const decodeWorking = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ person_id: RuntimePersonId })),
)

const unavailable = (cause: unknown) => new StoreUnavailable({ cause })

/** One call to the driver, its failure a `StoreUnavailable`. */
const sql = <A>(call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: unavailable })

/**
 * An idle pooled connection that dies is dropped by pg-pool, which then emits `error` on the
 * pool; with no listener that event would end the process. There is nothing else to do: the next
 * borrower gets a fresh connection.
 */
const idleFailure = (_cause: Error) => {}

/** Close the control connection on purpose: its loss listeners go first, so this is no loss. */
const closeControl = (client: Client, failed: () => void) =>
  Effect.sync(() => {
    client.removeListener('error', failed)
    client.removeListener('end', failed)
  }).pipe(Effect.andThen(Effect.tryPromise(() => client.end())), Effect.ignore)

/**
 * The control connection, for the life of the scope: its own client, outside the pool, so the
 * lock it holds lives exactly as long as it does. Its `error` or `end` before release settles
 * `lost`; the release removes those listeners first, so closing on purpose is not a loss.
 */
const control = Effect.fn('Stores.control')(function* (
  url: string,
  lost: Deferred.Deferred<never, ControlLost>,
) {
  const failed = () => Deferred.doneUnsafe(lost, Effect.fail(new ControlLost()))
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        const client = new Client({ connectionString: url })
        client.on('error', failed)
        client.on('end', failed)
        return client.connect().then(() => client)
      },
      catch: unavailable,
    }),
    (client) => closeControl(client, failed),
  )
})

/**
 * Statements reach PostgreSQL as literal text (`driver.ts`), which is only safe on a UTF8
 * connection; the pool's connections are made from the same address and settings as this one.
 */
const checkSettings = Effect.fn('Stores.checkSettings')(function* (client: Client) {
  const result = yield* sql(() =>
    client.query(`SELECT current_setting('client_encoding') AS client_encoding,
      current_setting('standard_conforming_strings') AS standard_conforming_strings`),
  )
  const row = yield* decodeSettings(result.rows[0]).pipe(Effect.mapError(unavailable))
  if (row.client_encoding !== 'UTF8')
    return yield* new ConnectionSettingInvalid({
      setting: 'client_encoding',
      value: row.client_encoding,
    })
  if (row.standard_conforming_strings !== 'on' && row.standard_conforming_strings !== 'off')
    return yield* new ConnectionSettingInvalid({
      setting: 'standard_conforming_strings',
      value: row.standard_conforming_strings,
    })
  return yield* Effect.void
})

/**
 * Where this package's generated migrations are, one directory each (`drizzle.config.ts`). Resolved
 * when checked, not at import: a host that imports `Stores` without this module's files (a celld
 * cell, whose bundle has no `import.meta.url`) must still load.
 */
const migrations = () => new URL('../../drizzle/', import.meta.url)

/**
 * Refuse to start until the database has the tables this code was written for: the newest
 * generated migration's name must be in the runtime's own ledger (`ledger.ts`). Checked before the lock is taken or
 * the owner row written, so a runtime ahead of its migration changes nothing.
 */
const checkMigrated = Effect.fn('Stores.checkMigrated')(function* (client: Client) {
  const shipped = yield* Effect.tryPromise({
    try: () => NodeFSP.readdir(migrations(), { withFileTypes: true }),
    catch: unavailable,
  })
  const names = shipped.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  names.sort()
  const expected = names.at(-1)
  if (expected === undefined) return yield* unavailable(new Error('No runtime migration ships'))
  const ledger = yield* sql(() =>
    client.query('SELECT to_regclass($1) IS NOT NULL AS present', [
      `${LEDGER.schema}.${LEDGER.table}`,
    ]),
  )

  if (!(yield* decodePresent(ledger.rows[0]).pipe(Effect.mapError(unavailable))).present)
    return yield* new MigrationsPending({ expected })
  const applied = yield* sql(() =>
    client.query(`SELECT 1 FROM ${LEDGER.schema}.${LEDGER.table} WHERE name = $1`, [expected]),
  )
  if (applied.rows.length === 0) return yield* new MigrationsPending({ expected })
  return yield* Effect.void
})

/**
 * Take the runtime's lock without waiting, then the next generation. A held lock is
 * `RuntimeOwned`: this process opens no store and stops. The generation goes up under the
 * owner row's lock, so the UPDATE waits for every write that still holds the old one's fence.
 */
const claim = Effect.fn('Stores.claim')(function* (client: Client) {
  const locked = yield* sql(() =>
    client.query('SELECT pg_try_advisory_lock($1::bigint) AS owned', [LOCK]),
  )
  if (!(yield* decodeClaim(locked.rows[0]).pipe(Effect.mapError(unavailable))).owned)
    return yield* new RuntimeOwned()
  const process = `${NodeOS.hostname()}:${globalThis.process.pid}:${NodeCrypto.randomUUID()}`
  const advanced = yield* sql(() =>
    client.query(
      `INSERT INTO runtime.owner (id, generation, process) VALUES (1, 1, $1)
       ON CONFLICT (id) DO UPDATE SET generation = runtime.owner.generation + 1, process = excluded.process
       RETURNING generation::text AS generation`,
      [process],
    ),
  )
  const row = yield* decodeGeneration(advanced.rows[0]).pipe(Effect.mapError(unavailable))
  return { generation: row.generation, process } satisfies Authority
})

/**
 * The fenced write that makes a store: its row, and its metadata row when the store row is new.
 * Pi's root conversation is id 1, so a new store's first id is 2 (Pi's reference schema).
 */
const makeStore = (database: Database, id: StoreId, personId: PersonId) =>
  database.write([], (transaction) =>
    transaction
      .get<object>(
        'INSERT INTO runtime.stores (id, person_id) VALUES (?, ?) ON CONFLICT (person_id) DO NOTHING RETURNING id',
        id,
        personId,
      )
      .then((made) => ({
        value: undefined,
        statements: Option.isSome(made)
          ? [
              {
                recordKind: 'metadata' as const,
                sql: 'INSERT INTO runtime.metadata (store_id, next_id, next_seq) VALUES (?, 2, 1)',
                params: [id],
              },
            ]
          : [],
      })),
  )

/**
 * The Person's store id, made with its metadata row the first time. Making it is a fenced write
 * like any other. The Person id is a column of `runtime.stores`, never the store's key.
 */
const storeOf = Effect.fn('Stores.storeOf')(function* (database: Database, personId: PersonId) {
  const select = () =>
    database.get<object>('SELECT id::text AS id FROM runtime.stores WHERE person_id = ?', personId)
  const found = yield* sql(select)
  if (Option.isSome(found))
    return (yield* decodeStore(found.value).pipe(Effect.mapError(unavailable))).id
  const id = StoreId.make(NodeCrypto.randomUUID())
  yield* sql(() => makeStore(database, id, personId))
  const made = yield* sql(select)
  if (Option.isNone(made)) return yield* unavailable(new Error('The store was not made'))
  return (yield* decodeStore(made.value).pipe(Effect.mapError(unavailable))).id
})

export const storesLayer = Layer.effect(
  Stores,
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings
    const url = Redacted.value(settings.databaseUrl)
    const lost = yield* Deferred.make<never, ControlLost>()
    // The pool is made first and ended last: every store has closed by the time it ends.
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url, max: POOL }).on('error', idleFailure)),
      (made) => Effect.promise(() => made.end()),
    )
    const client = yield* control(url, lost)
    yield* checkSettings(client)
    yield* checkMigrated(client)
    const database = new PooledDatabase(pool, yield* claim(client))

    const working = sql(() =>
      database.all<object>(
        `SELECT s.person_id FROM runtime.stores s
         WHERE EXISTS (SELECT 1 FROM runtime.tasks t WHERE t.store_id = s.id AND t.status <> 'terminal')
            OR EXISTS (SELECT 1 FROM runtime.submissions q WHERE q.store_id = s.id AND q.status = 'queued')
         ORDER BY s.person_id`,
      ),
    ).pipe(
      Effect.flatMap((rows) => decodeWorking(rows).pipe(Effect.mapError(unavailable))),
      Effect.map((rows) => rows.map((row) => row.person_id)),
    )

    return Stores.of({
      open: (personId) =>
        storeOf(database, personId).pipe(
          Effect.flatMap((storeId) => sql(() => PostgresStore.open(database, storeId))),
        ),
      working,
      lost: Deferred.await(lost),
    })
  }),
)
