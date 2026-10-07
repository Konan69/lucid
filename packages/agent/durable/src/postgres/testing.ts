import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Pool } from 'pg'
import { Effect, Schema } from 'effect'
import { onTestFinished } from 'vitest'

import { openPgStorage } from './pg.ts'
import type { PostgresStorage } from './storage.ts'

/** Tests supply only VIVID_TEST_DATABASE_URL. Random schemas isolate every case,
 * and removal is registered before opening storage or writing any SQL. No live
 * database settings are consulted; cleanup closes leases before dropping schemas. */
export function postgresFixture(url: string) {
  const parsed = new URL(url)
  if (parsed.port === '55433')
    throw new Error('PostgreSQL tests refuse the developer database port')
  const pool = new Pool({ connectionString: url, max: 4 })
  const schema = `durable_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  const storages = new Set<PostgresStorage>()
  onTestFinished(() =>
    Promise.all(Array.from(storages, (storage) => storage.close(BACKGROUND_CONTEXT)))
      .finally(() => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
      .finally(() => pool.end())
      .then(() => {}),
  )
  /** Reopening the same schema replaces volatile storage state only. */
  function open(): Promise<PostgresStorage> {
    return openPgStorage(pool, schema).then((storage) => {
      storages.add(storage)
      return storage
    })
  }
  /** Register a storage opened through a counting facade for the same cleanup. */
  function track(storage: PostgresStorage) {
    storages.add(storage)
  }
  return { pool, schema, open, track }
}

/** A rejected real Promise operation, with its original cause retained for assertions.
 * A successful operation is a test defect; no driver failure is converted to success. */
class PostgresTestRejected extends Schema.TaggedError<PostgresTestRejected>()(
  'PostgresTestRejected',
  { cause: Schema.Defect() },
  { title: 'Expected PostgreSQL test rejection' },
) {}

/** Observe expected failures through tryPromise, preserving toBe/toMatchObject and
 * toThrow assertion semantics without an unknown Effect error channel. */
export function rejected<A>(attempt: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: attempt,
    catch: (cause) => new PostgresTestRejected({ cause }),
  }).pipe(
    Effect.match({
      onSuccess: () => {
        throw new Error('Expected the Promise operation to reject')
      },
      onFailure: (error) => ({
        cause: error.cause,
        raise: () => {
          throw error.cause
        },
      }),
    }),
  )
}
