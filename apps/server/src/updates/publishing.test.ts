import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const repository = NodeURL.fileURLToPath(new URL('../../../../', import.meta.url))
const fixtures = NodePath.join(repository, 'apps/mobile/scripts/fixtures')

/**
 * Run the actual publishing consumer in a disposable tree. Only Expo's executable is replaced
 * with recorded SDK output. No bundle is built and the upload executable is inert, so this
 * proves parsing and map retention without credentials, a provider request, or product state.
 */
function publish(runtime: string) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-publishing-'))
  onTestFinished(() => NodeFS.rmSync(scratch, { recursive: true, force: true }))
  const scripts = NodePath.join(scratch, 'apps/mobile/scripts')
  const bin = NodePath.join(scratch, 'bin')
  NodeFS.mkdirSync(scripts, { recursive: true })
  NodeFS.mkdirSync(bin)
  NodeFS.mkdirSync(NodePath.join(scratch, 'scripts'))
  NodeFS.symlinkSync(
    NodePath.join(repository, 'node_modules'),
    NodePath.join(scratch, 'node_modules'),
  )
  NodeFS.copyFileSync(
    NodePath.join(repository, 'apps/mobile/scripts/publish.mjs'),
    NodePath.join(scripts, 'publish.mjs'),
  )
  NodeFS.copyFileSync(
    NodePath.join(fixtures, 'metadata.json'),
    NodePath.join(scratch, 'metadata.json'),
  )
  NodeFS.writeFileSync(NodePath.join(scratch, 'runtime.json'), runtime)
  NodeFS.writeFileSync(NodePath.join(scratch, 'scripts/sentry-upload.mjs'), '')
  NodeFS.writeFileSync(
    NodePath.join(bin, 'pnpm'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
if (args[0] !== 'exec') throw new Error('Unexpected command')
if (args[1] === 'expo-updates') {
  process.stdout.write(fs.readFileSync(path.join(root, 'runtime.json')))
} else if (args[2] === 'config') {
  process.stdout.write('{}')
} else if (args[2] === 'export') {
  const directory = args[args.indexOf('--output-dir') + 1]
  const text = fs.readFileSync(path.join(root, 'metadata.json'), 'utf8')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'metadata.json'), text)
  for (const platform of Object.values(JSON.parse(text).fileMetadata)) {
    for (const file of [platform.bundle, platform.bundle + '.map', ...platform.assets.map(asset => asset.path)]) {
      const target = path.join(directory, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'fixture bytes')
    }
  }
} else throw new Error('Unexpected Expo invocation')
`,
    { mode: 0o755 },
  )
  const output = NodePath.join(scratch, 'updates')
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(scripts, 'publish.mjs'), output],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}${NodePath.delimiter}${NodePath.dirname(process.execPath)}${NodePath.delimiter}/usr/bin:/bin`,
      },
    },
  )
  return { output, result }
}

/** The samples come from the installed Expo producer, not from our consumer's schema. */
it('publishes the SDK runtime and metadata samples through the production decoders', () => {
  const { output, result } = publish(
    NodeFS.readFileSync(NodePath.join(fixtures, 'runtime.json'), 'utf8'),
  )
  expect(result.status, result.stderr).toBe(0)
  const [runtime] = NodeFS.readdirSync(output)
  expect(runtime).toBe('0.3.12')
  const directory = NodePath.join(output, String(runtime))
  const [release] = NodeFS.readdirSync(directory)
  const files = NodeFS.readdirSync(NodePath.join(directory, String(release)), { recursive: true })
  expect(files).toContain('_expo/static/js/ios/launch.hbc')
  expect(files).toContain('_expo/static/js/android/launch.hbc')
  expect(files).toContain('assets/0123456789abcdef')
  expect(files.some((file) => String(file).endsWith('.map'))).toBe(false)
})

/** A legitimate unset SDK result and malformed answers must fail before any export is written. */
it.each([
  'null',
  '{}',
  NodeFS.readFileSync(NodePath.join(fixtures, 'unconfigured.json'), 'utf8'),
  '{"runtimeVersion":""}',
  '{"runtimeVersion":42}',
  '{',
])('refuses an unpublishable runtime answer %s', (runtime) => {
  const { output, result } = publish(runtime)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('expo-updates did not resolve a runtime version for ios')
  expect(NodeFS.existsSync(output)).toBe(false)
})
