import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { checkOwners } from './owners.mjs'

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

test('rejects the historical appearance writes and names each owner', () => {
  const findings = checkOwners(
    sources({
      'appearance/store.ts': `import { settingsTable } from '../settings/tables.ts'
import { companyTable } from '../companies/tables.ts'
tx.update(settingsTable).set({ vividName: appearance.name })
tx.update(companyTable).set({ vividName: appearance.name })`,
    }),
  )
  assert.deepEqual(findings, [
    {
      file: `${root}appearance/store.ts`,
      line: 3,
      operation: 'update',
      table: 'settingsTable',
      owner: 'settings',
    },
    {
      file: `${root}appearance/store.ts`,
      line: 4,
      operation: 'update',
      table: 'companyTable',
      owner: 'companies',
    },
  ])
})

for (const operation of ['insert', 'update', 'delete', 'upsert']) {
  test(`rejects cross-domain ${operation} including upserts built with insert`, () => {
    const findings = checkOwners(
      sources({
        'threads/store.ts': `import { companyTable } from '../companies/tables.ts'
database.${operation}(companyTable).values({}).onConflictDoUpdate({ set: {} })`,
      }),
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].operation, operation)
  })
}

test('allows reads and transactional membership checks across domains', () => {
  assert.deepEqual(
    checkOwners(
      sources({
        'threads/store.ts': `import { companyTable } from '../companies/tables.ts'
database.transaction(tx => tx.select().from(companyTable).where(eq(companyTable.id, id)))
database.select().from(threads).innerJoin(companyTable, eq(threads.companyId, companyTable.id))`,
        'companies/store.ts': `import { companyTable } from './tables.ts'
tx.insert(companyTable).values({})
tx.update(companyTable).set({})
tx.delete(companyTable)`,
      }),
    ),
    [],
  )
})

test('resolves renamed imports, namespace access, re-exports, and local aliases', () => {
  const findings = checkOwners(
    sources({
      'database/schema.ts': `export { companyTable as company } from '../companies/tables.ts'`,
      'appearance/store.ts': `import { company as renamed } from '../database/schema.ts'
import * as tables from '../companies/tables.ts'
const alias = renamed
tx.update(alias)
tx.delete(tables.companyTable)`,
    }),
  )
  assert.deepEqual(
    findings.map((finding) => [finding.operation, finding.table, finding.owner]),
    [
      ['update', 'companyTable', 'companies'],
      ['delete', 'companyTable', 'companies'],
    ],
  )
})

test('recognizes aliased table constructors and bracket mutation calls', () => {
  const findings = checkOwners(
    sources({
      'companies/tables.ts': `import { pgTable as table } from 'drizzle-orm/pg-core'
export const companyTable = table('company', {})`,
      'settings/tables.ts': `import * as pg from 'drizzle-orm/pg-core'
export const settingsTable = pg.pgTable('settings', {})`,
      'appearance/store.ts': `import { companyTable } from '../companies/tables.ts'
import { settingsTable } from '../settings/tables.ts'
tx['update'](companyTable)
tx['delete'](settingsTable)`,
    }),
  )
  assert.deepEqual(
    findings.map((finding) => [finding.operation, finding.owner]),
    [
      ['update', 'companies'],
      ['delete', 'settings'],
    ],
  )
})

test('ignores comments, strings, unrelated methods, and fixture writes', () => {
  assert.deepEqual(
    checkOwners(
      sources({
        'appearance/store.ts': `import { companyTable } from '../companies/tables.ts'
// database.update(companyTable)
const example = 'database.delete(companyTable)'
const cache = { update(key) { return key } }
cache.update(key)
const cycle = cycle
cache.update(cycle)`,
        'appearance/store.test.ts': `import { companyTable } from '../companies/tables.ts'; tx.delete(companyTable)`,
        'appearance/testing.ts': `import { companyTable } from '../companies/tables.ts'; tx.insert(companyTable)`,
        'library/fixtures.ts': `import { companyTable } from '../companies/tables.ts'; tx.insert(companyTable)`,
        'runtime/chains.ts': `import { companyTable } from '../companies/tables.ts'; tx.delete(companyTable)`,
      }),
    ),
    [],
  )
})

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

for (const operation of ['insert', 'update', 'delete', 'upsert']) {
  test(`fails closed for unresolved ${operation} targets and renamed builder methods`, () => {
    const findings = checkOwners(
      sources({
        'companies/store.ts': `const { ${operation}: mutate } = database
mutate(missing)
database.${operation}(lookup())
database['${operation}'](missing)
const called = database.${operation}
called(missing)
const bound = database.${operation}.bind(database)
bound(missing)`,
      }),
    )
    assert.equal(findings.length, 5)
    assert.ok(
      findings.every((finding) => finding.message.includes(`${operation} target is unresolved`)),
    )
  })
}

test('resolves typeof annotations, aliased unions and every member of a parameter target', () => {
  const findings = checkOwners(
    sources({
      'companies/replay.ts': `import { companyTable } from './tables.ts'
import { settingsTable } from '../settings/tables.ts'
type Target = typeof companyTable | typeof settingsTable
function replay(table: Target) { database.update(table) }
function remove(table: typeof settingsTable) { database.delete(table) }
const table: typeof settingsTable = settingsTable
database.insert(table)`,
    }),
  )
  assert.deepEqual(
    findings.map((finding) => [finding.operation, finding.table, finding.owner]),
    [
      ['update', 'settingsTable', 'settings'],
      ['delete', 'settingsTable', 'settings'],
      ['insert', 'settingsTable', 'settings'],
    ],
  )
})

test('an unresolved union member and a destructured table binding cannot silently pass', () => {
  const findings = checkOwners(
    sources({
      'companies/store.ts': `import { companyTable } from './tables.ts'
import * as tables from '../settings/tables.ts'
type Target = typeof companyTable | Missing
function replay(table: Target) { database.update(table) }
const { settingsTable: target } = tables
database.update(target)`,
    }),
  )
  assert.equal(findings.length, 2)
  assert.ok(findings.every((finding) => finding.message.includes('target is unresolved')))
})

test('distinguishes standard collections and explicitly declared local methods from builders', () => {
  assert.deepEqual(
    checkOwners(
      sources({
        'companies/store.ts': `import { settingsTable } from '../settings/tables.ts'
import * as Ref from 'effect/Ref'
import * as NodeCrypto from 'node:crypto'
function clear(values: Map<string, string>, ids: Set<string>) {
  values.delete('key')
  ids.delete('id')
}
const cache = { update(key: string | typeof settingsTable) { return key } }
const insert = makeInsert(database)
insert(actor, action, decision, null)
cache.update('key')
cache.update(settingsTable)
const update = cache.update.bind(cache)
update(settingsTable)
NodeCrypto.createHash('sha256').update('body')
Ref.update(ref, value => value + 1)`,
      }),
    ),
    [],
  )
})

for (const excluded of ['testing.ts', 'proof.ts', 'store.test.ts', 'tests/seed.ts']) {
  test(`rejects production imports, re-exports and dynamic imports of ${excluded}`, () => {
    const findings = checkOwners(
      sources({
        [`companies/${excluded}`]: `export const seed = () => database.update(missing)`,
        'companies/store.ts': `import { seed } from './${excluded}'
export { seed as setup } from './${excluded}'
const support = import('./${excluded}')`,
      }),
    )
    assert.equal(findings.length, 3)
    assert.ok(
      findings.every((finding) =>
        finding.message.includes('production imports excluded test support'),
      ),
    )
  })
}

test('fails when no tables or owning domains resolve', () => {
  assert.match(checkOwners(new Map())[0].message, /zero tables or zero domains/u)
  assert.match(
    checkOwners(new Map([[`${root}tables.ts`, company]]))[0].message,
    /zero tables or zero domains/u,
  )
  assert.match(
    checkOwners(new Map([[`${root}companies/store.ts`, 'database.update(missing)']]))[0].message,
    /zero tables or zero domains/u,
  )
})

test('resolves an absent domain entirely from source text when cwd is temporary', (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-owners-cwd-'))
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const files = new Map([
    [`${root}absent/tables.ts`, company],
    [
      `${root}writer/store.ts`,
      `import { companyTable } from '../absent/tables.ts'; database.update(companyTable)`,
    ],
  ])
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { checkOwners } from ${JSON.stringify(NodeURL.pathToFileURL(script).href)};
process.stdout.write(JSON.stringify(checkOwners(new Map(${JSON.stringify([...files])}))));`,
    ],
    { cwd: directory, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    JSON.stringify([
      {
        file: `${root}writer/store.ts`,
        line: 1,
        operation: 'update',
        table: 'companyTable',
        owner: 'absent',
      },
    ]),
  )
  assert.equal(NodeFS.existsSync(NodePath.join(directory, root, 'absent')), false)
})

test('resolves JavaScript import specifiers to excluded TypeScript support', () => {
  const findings = checkOwners(
    sources({
      'companies/testing.ts': 'export const seed = 1',
      'companies/store.ts': "import { seed } from './testing.js'",
    }),
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0].message, /excluded test support/u)
})

test('an unresolved target on an imported database cannot be dismissed as an unrelated SDK', () => {
  const findings = checkOwners(
    sources({
      'companies/store.ts': `import { database } from '@external/database'
database.update(missing)`,
    }),
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0].message, /target is unresolved/u)
})
