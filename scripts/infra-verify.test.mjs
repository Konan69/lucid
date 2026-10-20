import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import {
  imageSettings,
  readTargetDocument,
  unwatchedPaths,
  unwiredNames,
  validateTargets,
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
  assert.deepEqual(unwatchedPaths(dockerfile, 'packages/agent/runtime/Dockerfile', patterns), [
    'pnpm-lock.yaml',
    'scripts/migrate.mjs',
    '.dockerignore',
  ])
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
  assert.deepEqual([...imageSettings(dockerfile)].sort(), ['COREPACK_HOME', 'VIVID_BUILD_COMMIT'])
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
