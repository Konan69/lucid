import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { findForeignLockfiles, validatePackageManager } from './package-manager.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')

/** The checked-in repository keeps the package-manager pin and workspace policy aligned. */
void test('repository package-manager policy passes', () => {
  assert.deepEqual(validatePackageManager(repositoryRoot), [])
})

/** Foreign lockfiles are found in workspaces but ignored inside dependency/cache directories. */
void test('foreign lockfile discovery covers the workspace without traversing generated trees', () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-package-manager-'))
  try {
    NodeFS.mkdirSync(NodePath.join(root, 'apps', 'web'), { recursive: true })
    NodeFS.mkdirSync(NodePath.join(root, 'node_modules', 'example'), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(root, 'apps', 'web', 'yarn.lock'), '')
    NodeFS.writeFileSync(NodePath.join(root, 'node_modules', 'example', 'package-lock.json'), '')

    assert.deepEqual(findForeignLockfiles(root), ['apps/web/yarn.lock'])
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})
