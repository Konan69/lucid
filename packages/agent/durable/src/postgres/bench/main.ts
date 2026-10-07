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
async function readNumbers(
  storage: Storage,
  backend: string,
  counter: Option.Option<CountingDatabase>,
): Promise<Measurement[]> {
  const scale = Option.getOrThrow(Option.fromNullishOr(STORAGE_MEMORY_SCALES[0]))
  if (Option.isSome(counter)) counter.value.calls = 0
  const started = performance.now()
  const dataset = await seedStorageBenchmark(storage, scale)
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
    const result = await benchmark.run(storage, dataset)
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
}

/** Pi src/testing/storage-benchmark.ts:seedStorageWriteBenchmark and write cases.
 * Fresh storage ensures immutable root creation does not collide with read seeds. */
async function writeNumbers(
  storage: Storage,
  backend: string,
  counter: Option.Option<CountingDatabase>,
): Promise<Measurement[]> {
  await seedStorageWriteBenchmark(storage)
  const rows: Measurement[] = []
  for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
    if (Option.isSome(counter)) counter.value.calls = 0
    const begin = performance.now()
    const result = await benchmark.run(storage)
    rows.push({
      backend,
      operation: benchmark.name,
      milliseconds: performance.now() - begin,
      queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
    })
    if (result !== benchmark.expected)
      throw new Error(`Write benchmark result differed: ${benchmark.name}`)
  }
  for (const sample of await streamingWrites(storage)) {
    if (Option.isSome(counter)) counter.value.calls = 0
    const begin = performance.now()
    await storage.commit(sample.writes, context)
    rows.push({
      backend,
      operation: sample.name,
      milliseconds: performance.now() - begin,
      queries: Option.match(counter, { onNone: () => 0, onSome: (value) => value.calls }),
    })
  }
  return rows
}

/** Cleanup is established before migration writes; only this fresh schema is
 * dropped. No fixtures, credentials, shared database or live provider are used. */
async function withPostgres<T>(
  pool: Pool,
  use: (storage: Storage, counter: Option.Option<CountingDatabase>) => Promise<T>,
): Promise<T> {
  const schema = `durable_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  let storage = Option.none<Storage>()
  try {
    const database = new CountingDatabase(await openPgDatabase(pool, schema))
    storage = Option.some(await PostgresStorage.open(database, schema))
    return await use(Option.getOrThrow(storage), Option.some(database))
  } finally {
    if (Option.isSome(storage))
      await storage.value
        .close(context)
        .finally(() => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
    else await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }
}

/** Pi openNodeSqliteStorage(':memory:') is the unchanged baseline. */
async function withSqlite<T>(use: (storage: Storage) => Promise<T>): Promise<T> {
  const storage = await openNodeSqliteStorage(':memory:')
  try {
    return await use(storage)
  } finally {
    await storage.close(context)
  }
}

/** Explicit CLI entry, not part of the Promise storage adapter. Effect reads only
 * opt-in test configuration here; the adapter itself has no Effect runtime or env
 * access. URL remains Redacted until pool construction and is never printed.
 * Invoke with pnpm exec node --experimental-transform-types src/postgres/bench/main.ts.
 * Standalone timings use no test timeout, sleeps, polling or raised deadlines. */
async function main() {
  const settings = await Effect.runPromise(
    Effect.gen(function* () {
      const enabled = yield* Config.option(Config.String('VIVID_DURABLE_POSTGRES_BENCHMARK'))
      const url = yield* Config.option(Config.Redacted('VIVID_TEST_DATABASE_URL'))
      return { enabled, url }
    }),
  )
  if (!Option.contains('1')(settings.enabled)) {
    console.log('Storage benchmark skipped; set VIVID_DURABLE_POSTGRES_BENCHMARK=1 to opt in.')
    return
  }
  if (Option.isNone(settings.url))
    throw new Error('Storage benchmark requires VIVID_TEST_DATABASE_URL')
  const url = Redacted.value(settings.url.value)
  if (new URL(url).port === '55433')
    throw new Error('Storage benchmark refuses the developer database port')
  const pool = new Pool({ connectionString: url })
  try {
    const reads = await withPostgres(pool, (storage, counter) =>
      readNumbers(storage, 'PostgreSQL', counter),
    )
    reads.push(...(await withSqlite((storage) => readNumbers(storage, 'SQLite', Option.none()))))
    const writes = await withPostgres(pool, (storage, counter) =>
      writeNumbers(storage, 'PostgreSQL', counter),
    )
    writes.push(...(await withSqlite((storage) => writeNumbers(storage, 'SQLite', Option.none()))))
    console.log('Read timings (milliseconds, one measured call per operation):')
    console.table(reads)
    console.log('Write timings (milliseconds, one measured call per operation):')
    console.table(writes)
  } finally {
    await pool.end()
  }
}

await main()
