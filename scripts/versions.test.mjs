import * as NodeAssert from 'node:assert/strict'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { validateVersions, workspaceManifestPaths } from './versions.mjs'

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
