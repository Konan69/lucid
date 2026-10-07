import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { seedStorageWriteBenchmark, STORAGE_WRITE_BENCHMARKS } from '@earendil-works/pi-durable/testing'
import { CountingDatabase } from './bench/database.ts'
import { streamingWrites } from './bench/stream.ts'
import { openPgDatabase } from './pg.ts'
import { PostgresStorage } from './bench/original.ts'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
/** Counts successful driver calls through the actual facade, excluding setup.
 * No upstream test is altered; this also verifies the benchmark's expected values. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL round trips', () => {
  it('measures write benchmarks and streaming progress commits', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const database = new CountingDatabase(await openPgDatabase(fixture.pool, fixture.schema))
    const storage = await PostgresStorage.open(database, fixture.schema)
    fixture.track(storage)
    await seedStorageWriteBenchmark(storage)
    const measurements = []
    for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
      database.calls = 0
      const begin = performance.now()
      expect(await benchmark.run(storage)).toBe(benchmark.expected)
      measurements.push({ operation: benchmark.name, queries: database.calls, milliseconds: performance.now() - begin })
    }
    for (const sample of await streamingWrites(storage)) {
      database.calls = 0
      const begin = performance.now()
      await storage.commit(sample.writes, BACKGROUND_CONTEXT)
      measurements.push({ operation: sample.name, queries: database.calls, milliseconds: performance.now() - begin })
    }
    console.table(measurements)
  })
})
