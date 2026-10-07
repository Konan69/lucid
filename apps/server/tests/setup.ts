import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as Pg from 'pg'
import { afterAll, inject } from 'vitest'

/**
 * UUID rows alone cannot isolate global scheduler/replay scans. Give each file its own migrated
 * database before importing stores, while retaining normal fixture cleanup within the file.
 * Register teardown before creation; Effect test/layer scopes close their pools before afterAll.
 */
const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
if (supplied !== undefined) {
  const template = inject('serverDatabaseTemplate')
  // PostgreSQL identifiers have a 63-byte limit; the invocation prefix (at most 33 bytes) plus
  // 64 random bits fits.
  const name = `${inject('serverDatabasePrefix')}_${NodeCrypto.randomBytes(8).toString('hex')}`
  const admin = new Pg.Client({ connectionString: supplied })
  await admin.connect()
  // @effect-diagnostics-next-line asyncFunction:off -- Vitest afterAll requires a Promise-returning teardown callback.
  afterAll(async () => {
    const cleanup = new Pg.Client({ connectionString: supplied })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`)
    } finally {
      await cleanup.end()
      NodeProcess.env.VIVID_TEST_DATABASE_URL = supplied
    }
  })
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
    const target = new URL(supplied)
    target.pathname = `/${name}`
    NodeProcess.env.VIVID_TEST_DATABASE_URL = target.href
  } finally {
    await admin.end()
  }
}
