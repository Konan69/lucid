import * as NodeAssert from 'node:assert/strict'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { expectedDependencyVersion, validateVersions, workspaceManifestPaths } from './versions.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

/** The checked-in manifests are the lockstep contract, not only a synthetic fixture. */
void test('workspace versions and compiler paths remain locked', () => {
  assert.deepEqual(validateVersions(repositoryRoot), [])
})

/** Every visible package remains part of lockstep discovery as the monorepo grows. */
void test('workspace manifest discovery covers both apps and packages', () => {
  const manifests = workspaceManifestPaths(repositoryRoot)
  assert.ok(manifests.includes('apps/server/package.json'))
  assert.ok(manifests.includes('packages/contracts/package.json'))
})

/** Only the durable manifest selects Pi 1.0.4; the Flue runtime and catalog retain 0.87.1. */
void test('the Pi Durable exception cannot loosen another package or dependency', () => {
  assert.equal(
    expectedDependencyVersion('packages/agent/durable/package.json', '@earendil-works/pi-ai'),
    '1.0.4',
  )
  for (const manifest of ['package.json', ...workspaceManifestPaths(repositoryRoot)]) {
    if (manifest === 'packages/agent/durable/package.json') continue
    assert.equal(expectedDependencyVersion(manifest, '@earendil-works/pi-ai'), '0.87.1')
  }
  assert.equal(
    expectedDependencyVersion('packages/agent/durable/package.json', 'effect'),
    '4.0.0-rc.116',
  )
})
