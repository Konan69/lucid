import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodeHttp from 'node:http'
import * as NodeEvents from 'node:events'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as YAML from 'yaml'
import * as Schema from 'effect/Schema'

const assert = NodeAssert
const test = NodeTest.default
const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ expo: Schema.Record(Schema.String, Schema.Json) })),
)
const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))
const script = NodeURL.fileURLToPath(new URL('./release.mjs', import.meta.url))

/** Hook-exported Git variables must not redirect fixture writes into the caller's checkout. */
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
)

/** Fixtures exercise the CLI against real committed objects, with no installed fixture dependencies. */
function git(root, args) {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** Register cleanup before writing any fixture. Each repository and archive belongs to one case. */
function repository(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-release-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'release fixture'])
  git(root, ['config', 'user.email', 'release@localhost'])
  write(
    root,
    'apps/mobile/app.json',
    JSON.stringify({ expo: { name: 'Vivid', version: '0.3.9', runtimeVersion: '0.3.3' } }),
  )
  write(root, 'apps/mobile/package.json', '{}\n')
  write(root, 'apps/mobile/scripts/publish.mjs', 'const ALSO_RUNS_ON = []\n')
  write(root, 'pnpm-workspace.yaml', 'packages: [apps/mobile]\n')
  const lock = {
    lockfileVersion: '9.0',
    importers: { 'apps/mobile': {} },
    packages: {},
    snapshots: {},
  }
  saveLock(root, lock)
  return { root, lock }
}

/** File creation stays within the disposable repository and makes parent directories explicit. */
function write(root, file, contents) {
  const path = NodePath.join(root, file)
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true })
  NodeFS.writeFileSync(path, contents)
}

/** pnpm 12's prepended tool document must not be mistaken for the workspace graph. */
function saveLock(root, lock) {
  write(
    root,
    'pnpm-lock.yaml',
    `---\n${YAML.stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} })}---\n${YAML.stringify(lock)}`,
  )
}

/** Commit explicit fixture paths, preserving the same whole-push comparison as pre-push. */
function commit(root, paths, message) {
  git(root, ['add', '--', ...paths])
  git(root, ['commit', '--quiet', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

/** Fixture archives carry real tar listings and lock integrity, so detection cannot be mocked away. */
function dependency(fixture, name, generation, native) {
  const relative = `deps/${name}-${generation}.tgz`
  const directory = `.archive/${name}-${generation}`
  const file = native ? 'package/ios/View.swift' : 'package/index.js'
  write(fixture.root, `${directory}/${file}`, 'fixture\n')
  const result = NodeChildProcess.spawnSync(
    'tar',
    ['-czf', NodePath.join(fixture.root, relative), '-C', directory, 'package'],
    { cwd: fixture.root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const bytes = NodeFS.readFileSync(NodePath.join(fixture.root, relative))
  const reference = `file:${relative}`
  const key = `${name}@${reference}`
  fixture.lock.packages[key] = {
    resolution: {
      tarball: reference,
      integrity: `sha512-${NodeCrypto.createHash('sha512').update(bytes).digest('base64')}`,
    },
  }
  fixture.lock.snapshots[key] = {}
  return { reference, key, relative }
}

/** Only importer production edges seed the graph. */
function direct(fixture, name, entry) {
  fixture.lock.importers['apps/mobile'].dependencies = {
    [name]: { specifier: entry.reference, version: entry.reference },
  }
  saveLock(fixture.root, fixture.lock)
}

/** Change only the requested release fields; dirty working-tree changes remain invisible to the CLI. */
function version(root, fields) {
  const path = NodePath.join(root, 'apps/mobile/app.json')
  const config = decodeConfig(NodeFS.readFileSync(path, 'utf8'))
  Object.assign(config.expo, fields)
  write(root, 'apps/mobile/app.json', JSON.stringify(config))
}

/** The public entry point returns diagnostics and exit status against real Git refs. */
function check(root, args = []) {
  const result = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

void test('whole push rejects JS without a version bump, then accepts the second commit bump', (t) => {
  const { root } = repository(t)
  const base = commit(root, ['apps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], 'published')
  git(root, ['update-ref', 'refs/remotes/origin/main', base])
  write(root, 'apps/mobile/src/entry.ts', 'export const title = "new"\n')
  commit(root, ['apps/mobile/src/entry.ts'], 'phone JavaScript')
  assert.match(check(root).output, /Phone inputs changed; raise version/u)
  version(root, { version: '0.3.10' })
  assert.equal(check(root).status, 1, 'uncommitted bump does not count')
  commit(root, ['apps/mobile/app.json'], 'phone version')
  const result = check(root)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /phone release passed \(origin\/main\.\.HEAD\)/u)
})

void test('removed native dependency is resolved from the old revision with no node_modules', (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const entry = dependency(fixture, 'view', 1, true)
  direct(fixture, 'view', entry)
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published native view',
  )
  fixture.lock.importers['apps/mobile'] = {}
  delete fixture.lock.packages[entry.key]
  delete fixture.lock.snapshots[entry.key]
  saveLock(fixture.root, fixture.lock)
  NodeFS.rmSync(NodePath.join(fixture.root, entry.relative))
  version(fixture.root, { version: '0.3.10' })
  commit(
    fixture.root,
    ['apps/mobile/app.json', 'pnpm-lock.yaml', entry.relative],
    'remove native view',
  )
  const result = check(fixture.root, [base])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /Native inputs changed.*raise runtimeVersion/u)
})

void test('lockfile-only transitive native upgrade requires a newer runtime and an empty compatibility list', (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const first = dependency(fixture, 'view', 1, true)
  const second = dependency(fixture, 'view', 2, true)
  fixture.lock.packages['bridge@1.0.0'] = {
    resolution: { integrity: 'unchanged archive is never fetched' },
  }
  fixture.lock.snapshots['bridge@1.0.0'] = { dependencies: { view: first.reference } }
  direct(fixture, 'bridge', { reference: '1.0.0' })
  write(fixture.root, 'apps/mobile/scripts/publish.mjs', 'const ALSO_RUNS_ON = ["0.3.0"]\n')
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published transitive view',
  )
  fixture.lock.snapshots['bridge@1.0.0'].dependencies.view = second.reference
  saveLock(fixture.root, fixture.lock)
  version(fixture.root, { version: '0.3.10' })
  commit(fixture.root, ['apps/mobile/app.json', 'pnpm-lock.yaml'], 'lock-only native upgrade')
  const result = check(fixture.root, [base])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /raise runtimeVersion/u)
  assert.match(result.output, /empty ALSO_RUNS_ON/u)
  version(fixture.root, { runtimeVersion: '0.3.4' })
  write(fixture.root, 'apps/mobile/scripts/publish.mjs', 'const ALSO_RUNS_ON = []\n')
  commit(fixture.root, ['apps/mobile/app.json', 'apps/mobile/scripts/publish.mjs'], 'new binary')
  assert.equal(check(fixture.root, [base]).status, 0)
})

void test('a runtime-only patch outside the phone graph does not require a phone release', (t) => {
  const fixture = repository(t)
  write(fixture.root, 'patches/runtime.patch', 'old runtime patch\n')
  write(
    fixture.root,
    'pnpm-workspace.yaml',
    'patchedDependencies:\n  runtime@1.0.0: patches/runtime.patch\n',
  )
  fixture.lock.importers['packages/agent/runtime'] = {
    dependencies: { runtime: { version: '1.0.0' } },
  }
  fixture.lock.packages['runtime@1.0.0'] = { resolution: { integrity: 'not in phone graph' } }
  fixture.lock.snapshots['runtime@1.0.0'] = {}
  saveLock(fixture.root, fixture.lock)
  const base = commit(
    fixture.root,
    ['apps', 'patches', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published',
  )
  write(fixture.root, 'patches/runtime.patch', 'changed runtime patch\n')
  commit(fixture.root, ['patches/runtime.patch'], 'runtime patch')
  const result = check(fixture.root, [base])
  assert.equal(result.status, 0, result.output)
})

void test('a native phone patch requires a runtime bump even when package versions stay the same', (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const entry = dependency(fixture, 'view', 1, true)
  direct(fixture, 'view', entry)
  write(fixture.root, 'patches/view.patch', 'old native patch\n')
  write(
    fixture.root,
    'pnpm-workspace.yaml',
    YAML.stringify({ patchedDependencies: { [entry.key]: 'patches/view.patch' } }),
  )
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'patches', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published',
  )
  write(fixture.root, 'patches/view.patch', 'new native patch\n')
  version(fixture.root, { version: '0.3.10' })
  commit(fixture.root, ['apps/mobile/app.json', 'patches/view.patch'], 'native patch only')
  assert.match(check(fixture.root, [base]).output, /Native inputs changed.*raise runtimeVersion/u)
})

void test('zod and other JS-only dependencies keep the existing runtime', (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const entry = dependency(fixture, 'zod', 1, false)
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published',
  )
  direct(fixture, 'zod', entry)
  version(fixture.root, { version: '0.3.10' })
  commit(fixture.root, ['apps/mobile/app.json', 'pnpm-lock.yaml'], 'add JS dependency and version')
  const result = check(fixture.root, [base])
  assert.equal(result.status, 0, result.output)
  version(fixture.root, { runtimeVersion: '0.3.4' })
  commit(fixture.root, ['apps/mobile/app.json'], 'stranding runtime bump')
  assert.match(
    check(fixture.root, [base]).output,
    /JavaScript-only release; keep runtimeVersion unchanged/u,
  )
})

void test('phone closure follows workspace links while tests and docs remain outside shipped files', (t) => {
  const fixture = repository(t)
  fixture.lock.importers['apps/mobile'].dependencies = {
    shared: { version: 'link:../../packages/new/shared' },
  }
  fixture.lock.importers['packages/new/shared'] = {}
  saveLock(fixture.root, fixture.lock)
  const base = commit(fixture.root, ['apps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], 'published')
  write(fixture.root, 'packages/new/shared/src/value.test.ts', 'test fixture\n')
  write(fixture.root, 'apps/mobile/README.md', 'documentation\n')
  commit(fixture.root, ['packages', 'apps/mobile/README.md'], 'test and docs')
  assert.equal(check(fixture.root, [base]).status, 0)
  write(fixture.root, 'packages/new/shared/src/value.ts', 'export const value = 2\n')
  commit(fixture.root, ['packages/new/shared/src/value.ts'], 'shared phone code')
  assert.match(check(fixture.root, [base]).output, /raise version/u)
})

void test('replay of appVersion policy rejects the stranding bump and the c619b77c parent policy', (t) => {
  const { root } = repository(t)
  version(root, { version: '0.3.2', runtimeVersion: { policy: 'appVersion' } })
  const base = commit(root, ['apps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], 'before 1f0e5a34')
  assert.match(check(root, [base, base]).output, /runtimeVersion must be a literal string/u)
  version(root, { version: '0.3.3' })
  commit(root, ['apps/mobile/app.json'], 'replay 1f0e5a34 stranding bump')
  const result = check(root, [base])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /appVersion policy strands installed phones/u)
})

void test('native config and plugin changes require a rising runtime, never a rollback', (t) => {
  const { root } = repository(t)
  const base = commit(root, ['apps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], 'published')
  version(root, { version: '0.3.10', plugins: ['new-plugin'], runtimeVersion: '0.3.2' })
  commit(root, ['apps/mobile/app.json'], 'native config and runtime rollback')
  assert.match(check(root, [base]).output, /Native inputs changed.*raise runtimeVersion/u)
})

void test('unavailable archive integrity fails closed instead of approving an uninspected dependency', (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const entry = dependency(fixture, 'zod', 1, false)
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published',
  )
  direct(fixture, 'zod', entry)
  fixture.lock.packages[entry.key].resolution.integrity = 'sha512-invalid'
  saveLock(fixture.root, fixture.lock)
  version(fixture.root, { version: '0.3.10' })
  commit(fixture.root, ['apps/mobile/app.json', 'pnpm-lock.yaml'], 'invalid lock integrity')
  const result = check(fixture.root, [base])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /ArchiveFailure/u)
})

void test('locked registry archives use real HTTP and retry a transient availability failure', async (t) => {
  const fixture = repository(t)
  NodeFS.mkdirSync(NodePath.join(fixture.root, 'deps'))
  const entry = dependency(fixture, 'zod', 1, false)
  const base = commit(
    fixture.root,
    ['apps', 'deps', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    'published',
  )
  const bytes = NodeFS.readFileSync(NodePath.join(fixture.root, entry.relative))
  let requests = 0
  const server = NodeHttp.createServer((_request, response) => {
    requests++
    response.statusCode = requests === 1 ? 502 : 200
    response.end(requests === 1 ? 'temporarily unavailable' : bytes)
  })
  t.after(() => server.close())
  server.listen(0, '127.0.0.1')
  await NodeEvents.once(server, 'listening')
  const address = decodeAddress(server.address())
  fixture.lock.packages[entry.key].resolution.tarball =
    `http://127.0.0.1:${address.port}/locked.tgz`
  direct(fixture, 'zod', entry)
  version(fixture.root, { version: '0.3.10' })
  commit(fixture.root, ['apps/mobile/app.json', 'pnpm-lock.yaml'], 'registry JS dependency')
  const child = NodeChildProcess.spawn(process.execPath, [script, base], {
    cwd: fixture.root,
    env: environment,
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const [status] = await NodeEvents.once(child, 'close')
  assert.equal(status, 0, output)
  assert.equal(requests, 2)
})
