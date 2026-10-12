import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { typeScriptConfigErrors, workspaceManifestPaths } from './versions.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

/** Independently walk package trees so a newly added package cannot silently escape discovery. */
void test('workspace manifest discovery covers both apps and packages', () => {
  const inventory = ['apps', 'packages']
    .flatMap((parent) => {
      const visit = (directory) =>
        NodeFS.readdirSync(NodePath.join(repositoryRoot, directory), {
          withFileTypes: true,
        }).flatMap((entry) => {
          if (!entry.isDirectory() || entry.name === 'node_modules') return []
          const child = `${directory}/${entry.name}`
          const manifest = `${child}/package.json`
          return NodeFS.existsSync(NodePath.join(repositoryRoot, manifest))
            ? [manifest]
            : visit(child)
        })
      return visit(parent)
    })
    .toSorted((first, second) => first.localeCompare(second))
  assert.deepEqual(
    workspaceManifestPaths(repositoryRoot).toSorted((first, second) => first.localeCompare(second)),
    inventory,
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
