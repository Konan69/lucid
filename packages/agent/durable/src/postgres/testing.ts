import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Pool } from 'pg'
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
  onTestFinished(async () => {
    await Promise.all(Array.from(storages, (storage) => storage.close(BACKGROUND_CONTEXT)))
      .finally(() => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
      .finally(() => pool.end())
  })
  /** Reopening the same schema replaces volatile storage state only. */
  async function open() {
    const storage = await openPgStorage(pool, schema)
    storages.add(storage)
    return storage
  }
  /** Register a storage opened through a counting facade for the same cleanup. */
  function track(storage: PostgresStorage) {
    storages.add(storage)
  }
  return { pool, schema, open, track }
}
