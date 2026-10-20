import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { verifyImage } from './images.mjs'
import {
  imageSettings,
  readTargetDocument,
  unwatchedPaths,
  unwiredNames,
  validateTargets,
  verifyInfrastructure,
} from './infra-verify.mjs'

const assert = NodeAssert
const test = NodeTest.default

void test('target validation accepts the document and rejects unsafe mutations', () => {
  const original = readTargetDocument()
  assert.doesNotThrow(() => validateTargets(original))

  const duplicate = structuredClone(original)
  duplicate.preview.stackName = duplicate.local.stackName
  assert.throws(() => validateTargets(duplicate), /stackName values must be unique/)

  const destructive = structuredClone(original)
  destructive.production.destroyOnTeardown = true
  assert.throws(() => validateTargets(destructive), /production teardown must be protected/)
})

void test('a path an image is built from must be one its service watches', () => {
  const dockerfile = [
    'FROM node AS build',
    'COPY package.json pnpm-lock.yaml ./',
    'COPY apps/desktop/package.json apps/desktop/package.json',
    'COPY --chown=node:node scripts/migrate.mjs scripts/migrate.mjs',
    'COPY packages packages',
    'COPY --from=build /app/dist dist',
  ].join('\n')
  const patterns = ['/package.json', '/apps/*/package.json', '/packages/**']
  assert.deepEqual(unwatchedPaths(dockerfile, 'packages/agent/runtime/Dockerfile', patterns, []), [
    'pnpm-lock.yaml',
    'scripts/migrate.mjs',
    '.dockerignore',
  ])
})

/** Tiny repositories exercise the same filesystem and Dockerfile ingress as the policy command. */
function imageFixture(t, files) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-image-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  const documents = {
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'package.json': JSON.stringify({ name: '@vivid/workspace' }),
    '.dockerignore': '',
    'apps/server/package.json': JSON.stringify({
      name: '@vivid/server',
      dependencies: { '@vivid/contracts': 'workspace:*' },
    }),
    'packages/contracts/package.json': JSON.stringify({ name: '@vivid/contracts' }),
    ...files,
  }
  for (const [file, contents] of Object.entries(documents)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(root, file), contents)
  }
  return root
}

const manifestCopies = [
  'COPY apps/server/package.json apps/server/package.json',
  'COPY packages/contracts/package.json packages/contracts/package.json',
]
const install = 'RUN pnpm install --frozen-lockfile --filter @vivid/server...'

/** Fixing COPY is observable only when both the install and the production inputs are complete. */
function verifyFixture(root, lines) {
  return verifyImage({
    root,
    dockerfile: ['FROM node AS build', ...lines].join('\n'),
    stages: { build: ['@vivid/server'] },
  })
}

void test('the repository infrastructure policy runs in the gate infrastructure task', () => {
  assert.equal(verifyInfrastructure().result, 'ok')
})

void test('a production workspace edge requires its manifest before install and its source tree', (t) => {
  const root = imageFixture(t, {})
  assert.throws(
    () =>
      verifyFixture(root, [manifestCopies[0], install, 'COPY apps apps', 'COPY packages packages']),
    /COPY packages\/contracts\/package.json before pnpm install for @vivid\/contracts/,
  )
  assert.throws(
    () => verifyFixture(root, [...manifestCopies, install, 'COPY apps apps']),
    /COPY packages\/contracts for production workspace package @vivid\/contracts/,
  )
  assert.doesNotThrow(() =>
    verifyFixture(root, [...manifestCopies, install, 'COPY apps apps', 'COPY packages packages']),
  )
})

void test('installation needs development manifests but shipping does not require their source', (t) => {
  const root = imageFixture(t, {
    'apps/server/package.json': JSON.stringify({
      name: '@vivid/server',
      devDependencies: { '@vivid/contracts': 'workspace:*' },
    }),
  })
  assert.throws(
    () => verifyFixture(root, [manifestCopies[0], install, manifestCopies[1], 'COPY apps apps']),
    /COPY packages\/contracts\/package.json before pnpm install/,
  )
  assert.doesNotThrow(() => verifyFixture(root, [...manifestCopies, install, 'COPY apps apps']))
})

void test('an image cannot omit a shipping workspace from its install filters', (t) => {
  const root = imageFixture(t, {})
  assert.throws(
    () =>
      verifyFixture(root, [
        'COPY package.json ./',
        'RUN pnpm install --filter @vivid/workspace',
        'COPY apps apps',
        'COPY packages packages',
      ]),
    /pnpm install must select @vivid\/server/,
  )
})

void test('production closure includes transitive optional and peer workspace edges and terminates on cycles', (t) => {
  const root = imageFixture(t, {
    'packages/contracts/package.json': JSON.stringify({
      name: '@vivid/contracts',
      optionalDependencies: { '@vivid/skills': 'workspace:*' },
    }),
    'packages/skills/package.json': JSON.stringify({
      name: '@vivid/skills',
      peerDependencies: { '@vivid/contracts': 'workspace:*' },
    }),
  })
  assert.throws(
    () =>
      verifyFixture(root, [...manifestCopies, install, 'COPY apps apps', 'COPY packages packages']),
    /COPY packages\/skills\/package.json before pnpm install for @vivid\/skills/,
  )
  assert.doesNotThrow(() =>
    verifyFixture(root, ['COPY packages packages', ...manifestCopies, install, 'COPY apps apps']),
  )
})

void test('Docker stage inheritance and destinations determine which manifests are installed', (t) => {
  const root = imageFixture(t, {})
  assert.throws(
    () =>
      verifyFixture(root, [
        'COPY packages/contracts/package.json elsewhere/package.json',
        manifestCopies[0],
        install,
      ]),
    /COPY packages\/contracts\/package.json before pnpm install/,
  )
  assert.throws(
    () => verifyFixture(root, [...manifestCopies, 'FROM node AS unrelated', install]),
    /COPY apps\/server\/package.json before pnpm install/,
  )
  assert.doesNotThrow(() =>
    verifyImage({
      root,
      dockerfile: [
        'FROM node AS base',
        ...manifestCopies,
        install,
        'FROM base AS build',
        'COPY apps apps',
        'COPY packages packages',
      ].join('\n'),
      stages: { build: ['@vivid/server'] },
    }),
  )
})

void test('quoted negative filters can omit a development package from an image install', (t) => {
  const root = imageFixture(t, {
    'apps/server/package.json': JSON.stringify({
      name: '@vivid/server',
      devDependencies: { '@vivid/contracts': 'workspace:*' },
    }),
  })
  assert.doesNotThrow(() =>
    verifyFixture(root, [
      manifestCopies[0],
      `${install} --filter '!@vivid/contracts'`,
      'COPY apps apps',
    ]),
  )
})

void test('copied package configs require transitive root profiles and the files those profiles declare', (t) => {
  const root = imageFixture(t, {
    'packages/contracts/tsconfig.json':
      '{"extends": ["../../tsconfig.base.json", "../../tsconfig.hermes"]}',
    'tsconfig.base.json': '{ /* JSONC remains legal */ "compilerOptions": {}, }',
    'tsconfig.hermes.json': '{"files": ["hermes.d.ts"]}',
    'hermes.d.ts': 'interface Array<T> { findLast(): T }',
  })
  const copies = [
    ...manifestCopies,
    install,
    'COPY apps apps',
    'COPY packages packages',
    'COPY tsconfig.base.json ./',
  ]
  assert.throws(
    () => verifyFixture(root, copies),
    /COPY tsconfig.hermes.json because packages\/contracts\/tsconfig.json reads it/,
  )
  assert.throws(
    () => verifyFixture(root, [...copies, 'COPY tsconfig.hermes.json ./']),
    /COPY hermes.d.ts because tsconfig.hermes.json reads it/,
  )
  assert.throws(
    () =>
      verifyFixture(root, [
        ...copies,
        'RUN pnpm --filter @vivid/server build',
        'COPY tsconfig.hermes.json hermes.d.ts ./',
      ]),
    /COPY tsconfig.hermes.json because packages\/contracts\/tsconfig.json reads it/,
  )
  const inputs = verifyFixture(root, [...copies, 'COPY tsconfig.hermes.json hermes.d.ts ./'])
  assert.deepEqual(
    new Set(inputs),
    new Set(['tsconfig.base.json', 'tsconfig.hermes.json', 'hermes.d.ts']),
  )
  assert.deepEqual(
    unwatchedPaths(
      'COPY packages packages',
      'apps/server/Dockerfile',
      ['/packages/**', '/apps/server/Dockerfile', '/.dockerignore', '/tsconfig.base.json'],
      inputs,
    ),
    ['tsconfig.hermes.json', 'hermes.d.ts'],
  )
})

void test('broad package copies require configs outside the production dependency closure too', (t) => {
  const root = imageFixture(t, {
    'packages/unused/package.json': JSON.stringify({ name: '@vivid/unused' }),
    'packages/unused/tsconfig.json': '{"extends": "../../tsconfig.hermes.json"}',
    'tsconfig.hermes.json': '{}',
  })
  assert.throws(
    () =>
      verifyFixture(root, [...manifestCopies, install, 'COPY apps apps', 'COPY packages packages']),
    /COPY tsconfig.hermes.json because packages\/unused\/tsconfig.json reads it/,
  )
})

void test('build config imports require their outside helpers and follow transitive imports', (t) => {
  const root = imageFixture(t, {
    'apps/server/vite.config.ts': "export { default } from '../../scripts/bundle.js'",
    'scripts/bundle.ts': "import './shared.ts'",
    'scripts/shared.ts': 'export const value = 1',
  })
  const copies = [...manifestCopies, install, 'COPY apps apps', 'COPY packages packages']
  assert.throws(
    () => verifyFixture(root, copies),
    /COPY scripts\/bundle.ts because apps\/server\/vite.config.ts reads it/,
  )
  assert.throws(
    () => verifyFixture(root, [...copies, 'COPY scripts/bundle.ts scripts/bundle.ts']),
    /COPY scripts\/shared.ts because scripts\/bundle.ts reads it/,
  )
  assert.deepEqual(
    new Set(verifyFixture(root, [...copies, 'COPY scripts scripts'])),
    new Set(['scripts/bundle.ts', 'scripts/shared.ts']),
  )
})

void test('dockerignore cannot silently remove a required manifest or root config', (t) => {
  const root = imageFixture(t, { '.dockerignore': 'packages/contracts\n' })
  const copies = [...manifestCopies, install, 'COPY apps apps', 'COPY packages packages']
  assert.throws(
    () => verifyFixture(root, copies),
    /\.dockerignore excludes packages\/contracts\/package.json/,
  )
  NodeFS.writeFileSync(
    NodePath.join(root, '.dockerignore'),
    'packages/contracts\n!packages/contracts/**\n',
  )
  assert.throws(() => verifyFixture(root, copies), /\.dockerignore excludes packages\/contracts$/)
})

void test('an image sets what its last stage and the stages it descends from set', () => {
  const dockerfile = [
    'FROM node:24 AS base',
    'ENV COREPACK_HOME=/opt/corepack',
    'FROM base AS build',
    'ENV BUILD_ONLY=1',
    'FROM build AS updates',
    'ENV CI=1',
    'FROM base AS production',
    'ARG RAILWAY_GIT_COMMIT_SHA=""',
    'ENV VIVID_BUILD_COMMIT=$RAILWAY_GIT_COMMIT_SHA',
    'RUN VIVID_COMMIT="$RAILWAY_GIT_COMMIT_SHA" pnpm build',
  ].join('\n')
  assert.deepEqual(imageSettings(dockerfile), new Set(['COREPACK_HOME', 'VIVID_BUILD_COMMIT']))
})

void test('the server image wires only what the server alone reads', () => {
  const wired = (names) =>
    unwiredNames({
      wiringSource: 'VIVID_WEB_DIST: dist,',
      serverImage: new Set(['VIVID_BUILD_COMMIT', 'VIVID_RUNTIME_TOKEN']),
      ...names,
    })
  assert.deepEqual(
    wired({
      serverNames: new Set(['VIVID_BUILD_COMMIT', 'VIVID_WEB_DIST']),
      runtimeNames: new Set(),
    }),
    [],
  )
  // The runtime is another image: the server's ENV does not reach it.
  assert.deepEqual(
    wired({
      serverNames: new Set(['VIVID_RUNTIME_TOKEN']),
      runtimeNames: new Set(['VIVID_RUNTIME_TOKEN']),
    }),
    ['VIVID_RUNTIME_TOKEN'],
  )
  assert.deepEqual(wired({ serverNames: new Set(['CI']), runtimeNames: new Set() }), ['CI'])
})
