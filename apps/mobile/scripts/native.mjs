import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'

const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const platform = process.argv[2]
if (!['android', 'ios'].includes(platform)) throw new Error('Choose android or ios.')
function run(command, args, cwd = root) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: NodeProcess.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Expo's default bare template follows latest. Keep generated native projects
// on this app's SDK, including when android/ios are absent on a fresh checkout.
if (!NodeFS.existsSync(NodePath.join(root, platform))) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-expo-template-'))
  try {
    run('npm', [
      'pack',
      'expo-template-bare-minimum@57.0.26',
      '--ignore-scripts',
      '--prefer-offline',
      '--pack-destination',
      directory,
    ])
    run('pnpm', [
      'exec',
      'expo',
      'prebuild',
      '--platform',
      platform,
      '--template',
      NodePath.join(directory, 'expo-template-bare-minimum-57.0.26.tgz'),
      '--no-install',
    ])
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true })
  }
}
// A build made elsewhere (the unsigned iOS archive in `.github/workflows/sideload.yml`) needs only
// the generated native project, with the same pinned template, and drives Xcode itself.
if (process.argv[3] !== '--prebuild-only')
  run('pnpm', ['exec', 'expo', `run:${platform}`, ...process.argv.slice(3)])
