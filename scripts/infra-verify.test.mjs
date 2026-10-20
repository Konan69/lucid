import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import {
  imageSettings,
  readTargetDocument,
  unwatchedPaths,
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

void test('the settings an image sets for itself are read from its ENV lines', () => {
  const dockerfile = [
    'FROM node AS production',
    'ARG RAILWAY_GIT_COMMIT_SHA=""',
    'ENV VIVID_BUILD_COMMIT=$RAILWAY_GIT_COMMIT_SHA',
    'ENV PORT=8787',
    'RUN VIVID_COMMIT="$RAILWAY_GIT_COMMIT_SHA" pnpm build',
  ].join('\n')
  assert.deepEqual([...imageSettings(dockerfile)], ['VIVID_BUILD_COMMIT', 'PORT'])
})
