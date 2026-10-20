import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const assert = NodeAssert
const test = NodeTest.default
const OxlintOutputSchema = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      filename: Schema.String,
    }),
  ),
})
const ProcessFailureSchema = Schema.Struct({ stdout: Schema.String })
const decodeProcessFailure = Schema.decodeUnknownResult(ProcessFailureSchema)
const decodeOxlintOutput = Schema.decodeUnknownSync(Schema.fromJsonString(OxlintOutputSchema))

const scriptsDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const repositoryRoot = NodePath.resolve(scriptsDirectory, '..')
const oxlint = NodePath.join(repositoryRoot, 'node_modules', '.bin', 'oxlint')
const rule = NodeURL.pathToFileURL(NodePath.join(scriptsDirectory, 'boundary.mjs')).href

/**
 * A small workspace shaped like Vivid's: an app that exports nothing, an app that reaches into
 * it, and a package with an `exports` map. Each file names whether its imports cross.
 */
const workspace = {
  'apps/web/package.json': JSON.stringify({ name: '@fixture/web', exports: {} }),
  'apps/web/src/data/library.ts': 'export const shelvesOf = 1\n',
  'apps/mobile/package.json': JSON.stringify({ name: '@fixture/mobile', main: 'index.ts' }),
  'apps/mobile/src/data/local.ts': 'export const local = 1\n',
  'packages/tokens/package.json': JSON.stringify({
    name: '@fixture/tokens',
    exports: { './native': './src/native.ts' },
  }),
  'packages/tokens/src/native.ts': 'export const nativeThemes = 1\n',
  // c652f3ed: the phone's Library reached into the web app's data module.
  'apps/mobile/src/screen/library.ts':
    "import * as library from '../../../web/src/data/library'\nexport const shelves = library\n",
  'apps/mobile/src/screen/tokens.test.ts':
    "import { nativeThemes } from '../../../../packages/tokens/src/native.ts'\nexport const themes = nativeThemes\n",
  'apps/mobile/src/screen/forms.ts': [
    "export * from '../../../web/src/data/library'",
    "export { shelvesOf } from '../../../web/src/data/library.ts'",
    "export const later = () => import('../../../web/src/data/library')",
    "export const loaded = require('../../../web/src/data/library')",
    '',
  ].join('\n'),
  'apps/mobile/src/screen/inside.ts': [
    "import { local } from '../data/local'",
    "import raw from '../data/local.ts?raw'",
    "import { Effect } from 'effect'",
    'export const values = [local, raw, Effect]',
    '',
  ].join('\n'),
}

/** Lints the fixture workspace with only this rule and returns its findings by file. */
function lintWorkspace() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-boundary-'))
  try {
    for (const [file, text] of Object.entries(workspace)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, file)), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(directory, file), text)
    }
    const pluginPath = NodePath.join(directory, 'plugin.mjs')
    NodeFS.writeFileSync(
      pluginPath,
      `import { noCrossPackageImport } from '${rule}'\nexport default { meta: { name: 'vivid' }, rules: { 'no-cross-package-import': noCrossPackageImport } }\n`,
    )
    const configPath = NodePath.join(directory, 'oxlint.json')
    NodeFS.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: {},
        jsPlugins: [{ name: 'vivid', specifier: pluginPath }],
        rules: { 'vivid/no-cross-package-import': 'error' },
      }),
    )
    const run = () =>
      NodeChildProcess.execFileSync(
        oxlint,
        ['--config', configPath, '--format', 'json', NodePath.join(directory, 'apps')],
        { cwd: directory, encoding: 'utf8' },
      )
    const output = Result.match(Result.try(run), {
      onSuccess: (stdout) => stdout,
      onFailure: (cause) => {
        const failure = decodeProcessFailure(cause)
        if (Result.isFailure(failure)) throw cause
        return failure.success.stdout
      },
    })
    return decodeOxlintOutput(output).diagnostics.map((diagnostic) => ({
      file: NodePath.relative(directory, NodePath.resolve(directory, diagnostic.filename)),
      code: diagnostic.code,
      message: diagnostic.message,
    }))
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true })
  }
}

const findings = lintWorkspace()
const inFile = (file) => findings.filter((finding) => finding.file === file)

void test('reports the phone reaching into an app, and says to share it through a package', () => {
  const [finding] = inFile('apps/mobile/src/screen/library.ts')
  assert.equal(inFile('apps/mobile/src/screen/library.ts').length, 1)
  assert.equal(finding.code, 'vivid(no-cross-package-import)')
  assert.match(finding.message, /^@fixture\/mobile reaches into @fixture\/web by relative path\./u)
  assert.match(finding.message, /@fixture\/web exports nothing/u)
  assert.match(finding.message, /packages\/client\/state/u)
})

void test('reports a test reaching into a package, and names that package entry to use', () => {
  const [finding] = inFile('apps/mobile/src/screen/tokens.test.ts')
  assert.equal(inFile('apps/mobile/src/screen/tokens.test.ts').length, 1)
  assert.match(finding.message, /^@fixture\/mobile reaches into @fixture\/tokens/u)
  assert.match(finding.message, /"@fixture\/tokens"'s package\.json "exports"/u)
})

void test('covers re-exports, dynamic imports and require', () => {
  assert.equal(inFile('apps/mobile/src/screen/forms.ts').length, 4)
})

void test('accepts relative imports inside the package, with queries, and bare specifiers', () => {
  assert.deepEqual(inFile('apps/mobile/src/screen/inside.ts'), [])
})
