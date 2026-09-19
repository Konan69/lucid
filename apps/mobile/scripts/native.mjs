import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const platform = process.argv[2]
if (!['android', 'ios'].includes(platform)) throw new Error('Choose android or ios.')
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Expo's default bare template follows latest. Keep generated native projects
// on this app's SDK, including when android/ios are absent on a fresh checkout.
if (!existsSync(join(root, platform))) {
  const directory = mkdtempSync(join(tmpdir(), 'vivid-expo-template-'))
  try {
    run('npm', [
      'pack',
      'expo-template-bare-minimum@56.0.35',
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
      join(directory, 'expo-template-bare-minimum-56.0.35.tgz'),
      '--no-install',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
run('pnpm', ['exec', 'expo', `run:${platform}`, ...process.argv.slice(3)])
