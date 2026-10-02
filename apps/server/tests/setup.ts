import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as Pg from 'pg'
import { afterAll, inject } from 'vitest'
import './template.ts'

/**
 * UUID rows alone cannot isolate global scheduler/replay scans. Give each file its own migrated
 * database before importing stores, while retaining normal fixture cleanup within the file.
 * Register teardown before creation; Effect test/layer scopes close their pools before afterAll.
 */
const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
if (supplied !== undefined) {
  const template = inject('serverDatabaseTemplate')
  const name = `vivid_test_suite_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  const admin = new Pg.Client({ connectionString: supplied })
  await admin.connect()
  afterAll(async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    } finally {
      await admin.end()
      NodeProcess.env.VIVID_TEST_DATABASE_URL = supplied
    }
  })
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
  const target = new URL(supplied)
  target.pathname = `/${name}`
  NodeProcess.env.VIVID_TEST_DATABASE_URL = target.href
}
