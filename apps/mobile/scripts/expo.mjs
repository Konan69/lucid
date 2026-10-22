import * as NodeChildProcess from 'node:child_process'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'

const require = NodeModule.createRequire(import.meta.url)
const cli = NodePath.join(NodePath.dirname(require.resolve('expo/package.json')), 'bin/cli')
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [cli, 'start', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, EXPO_NO_TYPESCRIPT_SETUP: '1' },
  },
)
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
