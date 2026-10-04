import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { Config, Effect, Redacted, Schema } from 'effect'
import { Client, Pool } from 'pg'
import { flueStorage } from '../src/storage.ts'

/** A failed connection cannot own schema cleanup; no schema has been created yet. */
export class CleanupConnectionFailed extends Schema.TaggedError<CleanupConnectionFailed>()(
  'CleanupConnectionFailed',
  {},
  { title: 'Runtime cleanup connection failed' },
) {}

/** Creation failure retains the previously registered DROP on the surviving connection. */
export class SchemaCreationFailed extends Schema.TaggedError<SchemaCreationFailed>()(
  'SchemaCreationFailed',
  { schema: Schema.String },
  { title: 'Runtime schema creation failed' },
) {}

/**
 * Flue types the adapter's close as optional. This fixture requires it: without it nothing
 * owns pool.end(), so the fixture ends the pool itself and refuses to hand storage out.
 */
export class StorageCloseMissing extends Schema.TaggedError<StorageCloseMissing>()(
  'StorageCloseMissing',
  { schema: Schema.String },
  { title: 'Runtime storage has no close' },
) {}

export interface DisposableStorage {
  /** Generated identifier, safe to interpolate: runtime_test_<32 hex>. */
  readonly schema: string
  /** The production adapter is the only owner of pool.end(). */
  readonly storage: ReturnType<typeof flueStorage>
}

const closeFailed = Effect.sync(() => expect.fail('Runtime cleanup connection close failed'))
const dropFailed = Effect.sync(() => expect.fail('Runtime schema cleanup failed'))
const storageCloseFailed = Effect.sync(() => expect.fail('Runtime storage close failed'))
const poolCloseFailed = Effect.sync(() => expect.fail('Runtime storage pool close failed'))

/**
 * One schema on explicit disposable authority, using production storage. A separate cleanup
 * client survives Flue stop: releases run storage.close → DROP → cleanup.end. DROP is registered
 * before CREATE; the adapter's own idempotent close covers both normal and failed start. The
 * pool's release is registered before storage leaves this function, so no caller work (Flue
 * start, migration) can run while the pool is unowned.
 * Source: @flue/postgres 2.2.2 dist/index.mjs, postgres; @flue/runtime 2.2.2
 * dist/node/index.mjs, start. No app database composition root is imported.
 */
export const disposableStorage = Effect.fn('RuntimeTest.disposableStorage')(function* () {
  const url = yield* Config.Redacted('VIVID_TEST_DATABASE_URL')
  const schema = `runtime_test_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  const cleanup = new Client({ connectionString: Redacted.value(url) })
  // Register end before connecting, so a partially failed handshake is also released.
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => cleanup.end()).pipe(Effect.catch(() => closeFailed)),
  )
  yield* Effect.tryPromise({
    try: () => cleanup.connect(),
    catch: () => new CleanupConnectionFailed({}),
  })
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)).pipe(
      Effect.catch(() => dropFailed),
    ),
  )
  yield* Effect.tryPromise({
    try: () => cleanup.query(`CREATE SCHEMA ${schema}`),
    catch: () => new SchemaCreationFailed({ schema }),
  })
  const pool = new Pool({
    connectionString: Redacted.value(url),
    options: `-c search_path=${schema}`,
  })
  // pg 8.23.0 Pool connects lazily and flueStorage performs no I/O, so nothing between this
  // construction and the finalizer registered below can leave an open connection behind.
  const storage = flueStorage(pool)
  // flueStorage infers Flue's PersistenceAdapter, whose `close?(): void | Promise<void>` is
  // optional (@flue/runtime 2.2.2 dist/agent-execution-store-TmGF9yZ1.d.mts). Decide once who
  // ends the pool. A silent `storage.close?.()` would leave it open and hide that.
  if (storage.close === undefined) {
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => pool.end()).pipe(Effect.catch(() => poolCloseFailed)),
    )
    return yield* new StorageCloseMissing({ schema })
  }
  // Bound to its adapter: close is a method and must keep its receiver when called later.
  const closeStorage = storage.close.bind(storage)
  yield* Effect.addFinalizer(() =>
    // The async thunk turns the adapter's `void | Promise<void>` into the Promise that
    // Effect.tryPromise requires, and turns a synchronous throw into a rejection.
    Effect.tryPromise(async () => {
      await closeStorage()
    }).pipe(Effect.catch(() => storageCloseFailed)),
  )
  return { schema, storage } satisfies DisposableStorage
})()
