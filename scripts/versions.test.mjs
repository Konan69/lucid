import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { validateVersions, versions, workspaceManifestPaths } from './versions.mjs'

const PackageManagerManifest = Schema.Struct({
  packageManager: Schema.String,
  engines: Schema.Struct({ pnpm: Schema.String }),
})
const decodePackageManagerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageManagerManifest),
)
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

/** Exact prerelease pins are deliberate because semver drift changes Effect and Drizzle APIs. */
void test('critical prerelease versions are exact', () => {
  assert.equal(versions.effect, '4.0.0-rc.116')
  assert.equal(versions['drizzle-orm'], '1.0.0-rc.5-ab785fc')
  assert.equal(versions.electron, '44.4.3')
  assert.equal(versions['electron-builder'], '26.15.3')
  assert.equal(versions['electron-builder-squirrel-windows'], '26.15.3')
  assert.equal(versions.esbuild, '0.28.2')
  assert.equal(versions.alchemy, '2.0.0-beta.79')
  assert.equal(versions['better-auth'], '1.7.5')
  assert.equal(versions['@typescript/native'], 'npm:typescript@7.0.2')
  assert.equal(versions['@shadcn/lint'], '0.1.1')
  assert.equal(versions['@flue/runtime'], '2.1.0')
  assert.equal(versions.expo, '57.0.24')
  assert.equal(versions['react-native'], '0.86.3')
  assert.equal(versions.react, '19.2.3')
  assert.equal(versions['lucide-react'], '1.47.0')
  assert.equal(versions['@vitejs/plugin-react'], '6.1.1')
  assert.equal(versions['@earendil-works/pi-ai'], '0.83.0')
  assert.equal(versions['oxlint-tailwindcss'], '1.12.0')
  const manifest = decodePackageManagerManifest(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, 'package.json'), 'utf8'),
  )
  assert.equal(manifest.packageManager, 'pnpm@12.4.2')
  assert.equal(manifest.engines.pnpm, '12.4.2')
})
