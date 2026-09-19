import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateVersions, versions, workspaceManifestPaths } from './versions.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The checked-in manifests are the lockstep contract, not only a synthetic fixture. */
test('workspace versions and compiler paths remain locked', () => {
  assert.deepEqual(validateVersions(repositoryRoot), [])
})

/** Every visible package remains part of lockstep discovery as the monorepo grows. */
test('workspace manifest discovery covers both apps and packages', () => {
  const manifests = workspaceManifestPaths(repositoryRoot)
  assert.ok(manifests.includes('apps/server/package.json'))
  assert.ok(manifests.includes('packages/contracts/package.json'))
})

/** Exact prerelease pins are deliberate because semver drift changes Effect and Drizzle APIs. */
test('critical prerelease versions are exact', () => {
  assert.equal(versions.effect, '4.0.0-rc.116')
  assert.equal(versions['drizzle-orm'], '1.0.0-rc.5-ab785fc')
  assert.equal(versions.alchemy, '2.0.0-beta.79')
  assert.equal(versions['better-auth'], '1.7.5')
  assert.equal(versions['@typescript/native'], 'npm:typescript@7.0.2')
  assert.equal(versions['@shadcn/lint'], '0.1.1')
  assert.equal(versions['oxlint-tailwindcss'], '1.12.0')
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json')))
  assert.equal(manifest.packageManager, 'pnpm@12.4.2')
  assert.equal(manifest.engines.pnpm, '12.4.2')
})
