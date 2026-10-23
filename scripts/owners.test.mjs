import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'

const assert = NodeAssert
const test = NodeTest.default
const root = 'apps/server/src/'
const script = NodeURL.fileURLToPath(new URL('./owners.mjs', import.meta.url))
const company = `import { pgTable } from 'drizzle-orm/pg-core'
export const companyTable = pgTable('company', {})`
const settings = `import { pgTable } from 'drizzle-orm/pg-core'
export const settingsTable = pgTable('settings', {})`

/** Actual table declarations and local module resolution are exercised without any SDK runtime. */
function sources(files) {
  return new Map(
    Object.entries({
      'companies/tables.ts': company,
      'settings/tables.ts': settings,
      ...files,
    }).map(([file, source]) => [`${root}${file}`, source]),
  )
}

test('the CLI returns a failing status for foreign writes and passes after they move', (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-owners-'))
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  for (const [file, source] of sources({
    'appearance/store.ts': `import { companyTable } from '../companies/tables.ts'; tx.update(companyTable)`,
  })) {
    const target = NodePath.join(directory, file)
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true })
    NodeFS.writeFileSync(target, source)
  }
  const failed = NodeChildProcess.spawnSync(process.execPath, [script, '--root', directory], {
    cwd: NodeOS.tmpdir(),
    encoding: 'utf8',
  })
  assert.equal(failed.status, 1, failed.stderr)
  assert.match(failed.stderr, /update\(companyTable\) belongs to companies/u)
  NodeFS.renameSync(
    NodePath.join(directory, root, 'appearance/store.ts'),
    NodePath.join(directory, root, 'companies/store.ts'),
  )
  NodeFS.writeFileSync(
    NodePath.join(directory, root, 'companies/store.ts'),
    `import { companyTable } from './tables.ts'; tx.update(companyTable)`,
  )
  const passed = NodeChildProcess.spawnSync(process.execPath, [script, '--root', directory], {
    cwd: NodeOS.tmpdir(),
    encoding: 'utf8',
  })
  assert.equal(passed.status, 0, passed.stderr)
  assert.match(passed.stdout, /owners PASS/u)
})
