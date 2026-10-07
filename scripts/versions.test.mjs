import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import {
  expectedDependencyVersion,
  typeScriptConfigErrors,
  validateVersions,
  workspaceManifestPaths,
} from './versions.mjs'

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

/**
 * An Effect finding must fail typecheck. With an option `true`, or left to its default, the
 * compiler prints the finding and exits 0: 1,677 findings gathered that way before 7 Oct 2026.
 */
void test('an Effect finding that would not fail typecheck is refused', (context) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-versions-'))
  context.after(() => NodeFS.rmSync(root, { recursive: true }))
  const write = (plugin) =>
    NodeFS.writeFileSync(
      NodePath.join(root, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          plugins: [{ name: '@effect/language-service', diagnostics: true, ...plugin }],
        },
      }),
    )
  write({
    ignoreEffectErrorsInTscExitCode: true,
    ignoreEffectWarningsInTscExitCode: false,
  })
  assert.deepEqual(typeScriptConfigErrors(root), [
    'tsconfig.base.json: ignoreEffectErrorsInTscExitCode must be false',
    'tsconfig.base.json: ignoreEffectSuggestionsInTscExitCode must be false',
  ])
  write({
    ignoreEffectErrorsInTscExitCode: false,
    ignoreEffectWarningsInTscExitCode: false,
    ignoreEffectSuggestionsInTscExitCode: false,
  })
  assert.deepEqual(typeScriptConfigErrors(root), [])
})
