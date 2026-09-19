import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findForeignLockfiles, validatePackageManager } from './package-manager.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The checked-in repository keeps the package-manager pin and workspace policy aligned. */
void test('repository package-manager policy passes', () => {
  assert.deepEqual(validatePackageManager(repositoryRoot), [])
})

/** Foreign lockfiles are found in workspaces but ignored inside dependency/cache directories. */
void test('foreign lockfile discovery covers the workspace without traversing generated trees', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vivid-package-manager-'))
  try {
    mkdirSync(path.join(root, 'apps', 'web'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules', 'example'), { recursive: true })
    writeFileSync(path.join(root, 'apps', 'web', 'yarn.lock'), '')
    writeFileSync(path.join(root, 'node_modules', 'example', 'package-lock.json'), '')

    assert.deepEqual(findForeignLockfiles(root), ['apps/web/yarn.lock'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
