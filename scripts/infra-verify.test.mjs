import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import {
  readTargetDocument,
  unwatchedPaths,
  validateTargets,
  verifyInfrastructure,
} from './infra-verify.mjs'

const assert = NodeAssert
const test = NodeTest.default

void test('current infrastructure satisfies offline invariants', () => {
  assert.deepEqual(verifyInfrastructure(), {
    targets: 3,
    serverEnvironmentVariables: 7,
    result: 'ok',
  })
})

void test('duplicate physical names are rejected', () => {
  const targets = structuredClone(readTargetDocument())
  targets.preview.stackName = targets.local.stackName
  assert.throws(() => validateTargets(targets), /stackName values must be unique/)
})

void test('production teardown cannot be enabled', () => {
  const targets = structuredClone(readTargetDocument())
  targets.production.destroyOnTeardown = true
  assert.throws(() => validateTargets(targets), /production teardown must be protected/)
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
