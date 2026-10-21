import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeNet from 'node:net'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
export const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '../../../..',
)
export const skill = root + '/.agents/skills/verify-vivid'
export const dependencyLink =
  process.env.VIVID_VERIFY_DEPENDENCIES ?? skill + '/scripts/node_modules'
export const lock = root + '/.cache/verify-heavy.lock'
export const cache = process.env.VIVID_VERIFY_CACHE ?? root + '/.cache/verify'
export const boot = (await NodeFSP.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()

/** Atomic publication keeps ownership readable across a crash; independent evidence writers
 * use unique sibling temporaries, so they never share a rename. */
export async function json(path, value) {
  const temporary = path + '.' + crypto.randomUUID() + '.tmp'
  await NodeFSP.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await NodeFSP.rename(temporary, path)
}

/** Spawn ownership is captured at acquisition, never reconstructed by command-name matching. */
export async function identity(pid) {
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, 'utf8')
  return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], boot }
}
/** Linux start ticks prevent a reused PID or unreaped zombie from passing a liveness check. */
export async function alive(process) {
  if (process === undefined || (process.boot !== undefined && process.boot !== boot)) return false
  try {
    const stat = await NodeFSP.readFile(`/proc/${process.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[0] !== 'Z' && fields[19] === process.start
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false
    throw error
  }
}
/** Reserve all listeners together, so a just-closed ephemeral port cannot be chosen twice.
 * Strict product binding detects a later race; the developer PostgreSQL port is always refused. */
export async function freePorts(roles) {
  const listeners = []
  const ports = {}
  try {
    for (const role of roles) {
      const listener = NodeNet.createServer()
      listeners.push(listener)
      listener.listen(0, '127.0.0.1')
      await NodeEvents.once(listener, 'listening')
      const port = listener.address().port
      if (port === 55433) throw new Error('Reserved developer port; rerun launch')
      ports[role] = port
    }
    return ports
  } finally {
    await Promise.all(
      listeners.map((listener) => new Promise((resolve) => listener.close(resolve))),
    )
  }
}

/** CLI subprocesses retain exact commands and outputs; supplied credentials belong only in env. */
export const runningCommands = new Map()

export async function command(
  argv,
  { cwd = root, env = process.env, log, heavy = false, redactions = [], record } = {},
) {
  const started = Date.now()
  const executable = heavy ? ['flock', lock, ...argv] : argv
  const child = NodeChildProcess.spawn(executable[0], executable.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (bytes) => {
    output += bytes
  })
  child.stderr.on('data', (bytes) => {
    output += bytes
  })
  const closed = NodeEvents.once(child, 'close')
  child.once('close', () => runningCommands.delete(child.pid))
  const owned = await identity(child.pid).catch((error) => {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null
    throw error
  })
  if (owned && child.exitCode === null && child.signalCode === null)
    runningCommands.set(child.pid, { child, owned })
  if (owned && record) {
    try {
      await record(owned)
    } catch (error) {
      // Failed journaling cannot leave an unrecorded queued worker or SSH command behind.
      await terminate(owned, 'SIGTERM', true)
      await closed
      throw error
    }
  }
  const [code] = await closed
  const display = executable.map((value) => (redactions.includes(value) ? '<redacted>' : value))
  for (const value of redactions) output = output.replaceAll(value, '<redacted>')
  if (log)
    await NodeFSP.writeFile(
      log,
      JSON.stringify(
        { command: display, code, seconds: (Date.now() - started) / 1000, output },
        null,
        2,
      ) + '\n',
    )
  if (code !== 0) throw new Error(`${display.join(' ')} exited ${code}: ${output}`)
  return output.trim()
}

/** Readiness is a bound-listener log/IPC event. This deadline fails hung launch; it never marks ready. */
export function signal(child, emitter, event, predicate, milliseconds = 300_000) {
  const prior = child.observed?.[event]?.find(predicate)
  if (prior !== undefined) return Promise.resolve(prior)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Readiness deadline expired')), milliseconds)
    const onExit = (code, sig) =>
      finish(new Error(`Owned child exited ${code}/${sig} before readiness`))
    const onEvent = (value) => {
      if (predicate(value)) finish(null, value)
    }
    function finish(error, value) {
      clearTimeout(timeout)
      emitter.off(event, onEvent)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(value)
    }
    emitter.on(event, onEvent)
    child.once('exit', onExit)
  })
}

/** Port ownership is read from Linux socket inodes and the captured process's fd table. */
export async function ownsPort(owned, port) {
  if (!(await alive(owned))) return false
  const sockets = new Set()
  for (const name of await NodeFSP.readdir(`/proc/${owned.pid}/fd`)) {
    try {
      sockets.add(await NodeFSP.readlink(`/proc/${owned.pid}/fd/${name}`))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  for (const table of ['tcp', 'tcp6']) {
    const lines = (await NodeFSP.readFile(`/proc/${owned.pid}/net/${table}`, 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
    if (
      lines.some((line) => {
        const fields = line.trim().split(/\s+/)
        return (
          parseInt(fields[1].split(':')[1], 16) === port &&
          fields[3] === '0A' &&
          sockets.has(`socket:[${fields[9]}]`)
        )
      })
    )
      return true
  }
  return false
}

/** Only recorded PIDs with the original Linux start time may be signalled after a CLI restart. */
export async function terminate(owned, sig = 'SIGTERM', group = false) {
  if (await alive(owned)) process.kill(group ? -owned.pid : owned.pid, sig)
}
