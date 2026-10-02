import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as Pg from 'pg'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    serverDatabaseTemplate: string
  }
}

/**
 * Migrate an empty template once through both production migration owners. Each test file clones
 * it, preserving foreign keys and indexes without sharing scheduler work or copying fixture rows.
 * The supplied database is only an administration connection; no fixture or migration writes to it.
 */
export default async function setup(project: TestProject) {
  const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
  if (supplied === undefined) return () => {}
  const name = `vivid_test_template_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  const admin = new Pg.Client({ connectionString: supplied })
  const target = new URL(supplied)
  target.pathname = `/${name}`
  await admin.connect()
  // Define cleanup before creating the database, including failures during migration/setup.
  const cleanup = async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    } finally {
      await admin.end()
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    for (const config of ['drizzle.config.ts', 'product-drizzle.config.ts']) {
      const migration = NodeChildProcess.spawnSync(
        'pnpm',
        ['exec', 'drizzle-kit', 'migrate', '--config', config],
        {
          cwd: NodeURL.fileURLToPath(new URL('../', import.meta.url)),
          env: { ...NodeProcess.env, DATABASE_URL: target.href },
          stdio: 'pipe',
        },
      )
      if (migration.error !== undefined || migration.status !== 0)
        throw new Error(`Test template migration failed for ${config}`)
    }
    project.provide('serverDatabaseTemplate', name)
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}
