import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  seedStorageBenchmark,
  seedStorageWriteBenchmark,
  STORAGE_MEMORY_SCALES,
  STORAGE_READ_BENCHMARKS,
  STORAGE_WRITE_BENCHMARKS,
} from '@earendil-works/pi-durable/testing'
import { Config, Effect, Option, Redacted } from 'effect'
import { Pool } from 'pg'
import { openPgDatabase } from '../pg.ts'
import { PostgresStorage } from '../storage.ts'
import { CountingDatabase } from './database.ts'
import { streamingWrites } from './stream.ts'
const context = BACKGROUND_CONTEXT
type Measurement = {
  readonly backend: string
  readonly operation: string
  readonly milliseconds: number
  readonly queries: number
}
/** Pi src/testing/storage-benchmark.ts:seedStorageBenchmark and read cases, once
 * at its smallest published scale. Validate results; impose no timing threshold. */
function readNumbers(storage: Storage, backend: string, counter: Option.Option<CountingDatabase>) {
  return Effect.gen(function* () {
    const scale = Option.getOrThrow(Option.fromNullishOr(STORAGE_MEMORY_SCALES[0]))
    if (Option.isSome(counter)) counter.value.calls = 0
    const started = performance.now()
    const dataset = yield* Effect.promise(() => seedStorageBenchmark(storage, scale))
    const rows: Measurement[] = [
      {
        backend,
        operation: `seed ${scale.name} (${scale.entryCount}/${scale.taskCount}/${scale.documentCount})`,
        milliseconds: performance.now() - started,
        queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
      },
    ]
    for (const benchmark of STORAGE_READ_BENCHMARKS) {
      if (Option.isSome(counter)) counter.value.calls = 0
      const begin = performance.now()
      const result = yield* Effect.promise(() => benchmark.run(storage, dataset))
      rows.push({
        backend,
        operation: benchmark.name,
        milliseconds: performance.now() - begin,
        queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
      })
      if (result !== benchmark.expected(dataset))
        throw new Error(`Read benchmark result differed: ${benchmark.name}`)
    }
    return rows
  })
}
/** Pi src/testing/storage-benchmark.ts:seedStorageWriteBenchmark and write cases.
 * Fresh storage ensures immutable root creation does not collide with read seeds. */
function writeNumbers(storage: Storage, backend: string, counter: Option.Option<CountingDatabase>) {
  return Effect.gen(function* () {
    yield* Effect.promise(() => seedStorageWriteBenchmark(storage))
    const rows: Measurement[] = []
    for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
      if (Option.isSome(counter)) counter.value.calls = 0
      const begin = performance.now()
      const result = yield* Effect.promise(() => benchmark.run(storage))
      rows.push({
        backend,
        operation: benchmark.name,
        milliseconds: performance.now() - begin,
        queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
      })
      if (result !== benchmark.expected)
        throw new Error(`Write benchmark result differed: ${benchmark.name}`)
    }
    for (const sample of yield* streamingWrites(storage)) {
      if (Option.isSome(counter)) counter.value.calls = 0
      const begin = performance.now()
      yield* Effect.promise(() => storage.commit(sample.writes, context))
      rows.push({
        backend,
        operation: sample.name,
        milliseconds: performance.now() - begin,
        queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
      })
    }
    return rows
  })
}
/** Cleanup is established before migration writes; only this fresh schema is
 * dropped. No fixtures, credentials, shared database or live provider are used. */
function withPostgres<T>(
  pool: Pool,
  use: (storage: Storage, counter: Option.Option<CountingDatabase>) => Effect.Effect<T>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const schema = `durable_${NodeCrypto.randomUUID().replaceAll('-', '')}`
      let storage = Option.none<Storage>()
      // Register schema removal before the first migration write, even if opening fails.
      yield* Effect.addFinalizer(() => releaseSchema(pool, schema, storage))
      const database = new CountingDatabase(
        yield* Effect.promise(() => openPgDatabase(pool, schema)),
      )
      storage = Option.some(yield* Effect.promise(() => PostgresStorage.open(database, schema)))
      return yield* use(Option.getOrThrow(storage), Option.some(database))
    }),
  )
}

/** Release the lease before dropping its schema, even if close itself rejects.
 * The finalizer is registered before migration writes; host pool ownership stays separate. */
function releaseSchema(pool: Pool, schema: string, storage: Option.Option<Storage>) {
  return Effect.promise(() => {
    const closing = Option.match(storage, {
      onNone: () => Promise.resolve(),
      onSome: (owned) => owned.close(context),
    })
    return closing.finally(() => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
  }).pipe(Effect.asVoid)
}
/** Pi openNodeSqliteStorage(':memory:') is the unchanged baseline. */
function withSqlite<T>(use: (storage: Storage) => Effect.Effect<T>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.promise(() => openNodeSqliteStorage(':memory:')),
        (owned) => Effect.promise(() => owned.close(context)),
      )
      return yield* use(storage)
    }),
  )
}

/** Explicit CLI entry, not part of the Promise storage adapter. Effect reads only
 * opt-in test configuration here; the adapter itself has no Effect runtime or env
 * access. URL remains Redacted until pool construction and is never printed.
 * Invoke with pnpm exec node --experimental-transform-types src/postgres/bench/main.ts.
 * Standalone timings use no test timeout, sleeps, polling or raised deadlines. */
function main() {
  return Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* Effect.gen(function* () {
        const enabled = yield* Config.option(Config.String('VIVID_DURABLE_POSTGRES_BENCHMARK'))
        const url = yield* Config.option(Config.Redacted('VIVID_TEST_DATABASE_URL'))
        return { enabled, url }
      })
      if (!Option.contains('1')(settings.enabled)) {
        console.log('Storage benchmark skipped; set VIVID_DURABLE_POSTGRES_BENCHMARK=1 to opt in.')
        return
      }
      if (Option.isNone(settings.url))
        throw new Error('Storage benchmark requires VIVID_TEST_DATABASE_URL')
      const url = Redacted.value(settings.url.value)
      if (new URL(url).port === '55433')
        throw new Error('Storage benchmark refuses the developer database port')
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: url })),
        (owned) => Effect.promise(() => owned.end()),
      )
      const reads = yield* withPostgres(pool, (storage, counter) =>
        readNumbers(storage, 'PostgreSQL', counter),
      )
      reads.push(...(yield* withSqlite((storage) => readNumbers(storage, 'SQLite', Option.none()))))
      const writes = yield* withPostgres(pool, (storage, counter) =>
        writeNumbers(storage, 'PostgreSQL', counter),
      )
      writes.push(
        ...(yield* withSqlite((storage) => writeNumbers(storage, 'SQLite', Option.none()))),
      )
      console.log('Read timings (milliseconds, one measured call per operation):')
      console.table(reads)
      console.log('Write timings (milliseconds, one measured call per operation):')
      console.table(writes)
    }),
  )
}
await Effect.runPromise(main())
