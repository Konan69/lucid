import * as NodeAssert from 'node:assert/strict'
import * as NodeCrypto from 'node:crypto'
import * as NodeModule from 'node:module'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { openRunDatabase } from './database.mjs'

const root = NodeURL.fileURLToPath(new URL('../../', import.meta.url))
const require = NodeModule.createRequire(new URL('../../apps/server/package.json', import.meta.url))
const Pg = require('pg')

/** Every fixture uses only the disposable authority supplied by the gate. Cleanup is
 * registered before connecting or creating a database, including a failed setup. */
async function fixture(t) {
  const supplied = process.env.VIVID_TEST_DATABASE_URL
  NodeAssert.ok(supplied, 'VIVID_TEST_DATABASE_URL must identify isolated disposable PostgreSQL')
  const authority = new URL(supplied)
  authority.pathname = '/postgres'
  const admin = new Pg.Client({ connectionString: authority.href })
  const names = new Set()
  const owners = []
  t.after(async () => {
    for (const owner of owners) await owner.close()
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.end()
  })
  await admin.connect()
  const open = async () => {
    const id = NodeCrypto.randomBytes(12).toString('hex')
    const owner = await openRunDatabase(root, process.env, id)
    owners.push(owner)
    return new URL(owner.url).pathname.slice(1)
  }
  return { admin, names, open }
}

NodeTest.test(
  'a later gate preserves a live owner even when its legacy creation date is old',
  async (t) => {
    const { admin, open } = await fixture(t)
    const live = await open()
    await admin.query(`COMMENT ON DATABASE "${live}" IS '1'`)
    await open()
    const found = await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [live])
    NodeAssert.equal(found.rowCount, 1)
  },
)

NodeTest.test(
  'a gate reclaims an abandoned lease without expiring a concurrent live owner',
  async (t) => {
    const { admin, names, open } = await fixture(t)
    const live = await open()
    const orphan = `gate_${NodeCrypto.randomBytes(12).toString('hex')}`
    names.add(orphan)
    await admin.query(`CREATE DATABASE "${orphan}" TEMPLATE template0`)
    await admin.query(`COMMENT ON DATABASE "${orphan}" IS 'vivid-gate-owner-v1'`)
    await open()
    const found = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1)', [
      [live, orphan],
    ])
    NodeAssert.deepEqual(
      found.rows.map((row) => row.datname),
      [live],
    )
  },
)
