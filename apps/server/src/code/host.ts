import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeProcess from 'node:process'
import { Option } from 'effect'

/** Test admission probes the actual host primitives; absence is a stated skip, not a larger timeout. */
export function programHost(runtime: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(runtime)) return Option.some('XDG_RUNTIME_DIR is absent')
  if (!NodeProcess.execPath.startsWith('/usr/'))
    return Option.some('Node must be installed under /usr')
  for (const path of [
    '/usr/bin/systemd-run',
    '/usr/bin/systemctl',
    '/usr/bin/bwrap',
    '/usr/bin/prlimit',
  ])
    if (!NodeFS.existsSync(path)) return Option.some(`${path} is absent`)
  const manager = NodeChildProcess.spawnSync(
    '/usr/bin/systemctl',
    ['--user', 'show', '--property=ControlGroup', '--value'],
    {
      env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime.value },
      encoding: 'utf8',
      timeout: 5000,
    },
  )
  if (manager.status !== 0) return Option.some('systemd user bus is unavailable')
  const controllers = `/sys/fs/cgroup${manager.stdout.trim()}/cgroup.controllers`
  if (!NodeFS.existsSync(controllers)) return Option.some('cgroup v2 delegation is absent')
  const delegated = NodeFS.readFileSync(controllers, 'utf8').split(/\s+/u)
  if (!['memory', 'cpu', 'pids'].every((name) => delegated.includes(name)))
    return Option.some('memory, cpu and pids cgroup controllers must be delegated')
  const sandbox = NodeChildProcess.spawnSync(
    '/usr/bin/bwrap',
    [
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind',
      '/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '/usr/bin/true',
    ],
    { encoding: 'utf8', timeout: 5000 },
  )
  return sandbox.status === 0 ? Option.none() : Option.some('bubblewrap namespaces are unavailable')
}
