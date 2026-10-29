import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
import { hosts, pc } from './hosts.mjs'

const [action, alias, ...rest] = process.argv.slice(2)
if (alias === pc.alias) {
  if (!['attach', 'status'].includes(action)) throw new Error('verify android attach|status pc')
  process.exit(await local(action, rest))
}
if (!Object.hasOwn(hosts, alias) || !['provision', 'stop', 'status'].includes(action))
  throw new Error('verify android provision|stop|status <devbox-pick alias> | attach|status pc')

/** The PC needs no SSH: install the cached phone tools here, then record the running Windows
 * emulator. Nothing is started, so nothing here is ever stopped. */
async function local(verb, extra) {
  const run = async (file, args) => {
    const child = NodeChildProcess.spawn(
      'python3',
      [new URL(file, import.meta.url).pathname, ...args],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    const [code] = await NodeEvents.once(child, 'close')
    return code === null ? 1 : code
  }
  if (verb === 'attach') {
    const code = await run('./tools.py', [])
    if (code !== 0) return code
  }
  return run('./attach.py', [verb, pc.machineId, ...extra])
}

/** Boat's proxy has truncated transfers. Check the entire stdin payload before interpreting it,
 * and repeat the sandbox check for every SSH invocation, including the tool bootstrap. */
async function remote(file, verb) {
  const source = await NodeFSP.readFile(new URL(file, import.meta.url))
  const digest = NodeCrypto.createHash('sha256').update(source).digest('hex')
  const launcher = `import sys,hashlib,os
source=sys.stdin.buffer.read()
if os.environ.get('BOAT_ID') != '${hosts[alias]}': raise SystemExit('Host identity mismatch')
if hashlib.sha256(source).hexdigest() != '${digest}': raise SystemExit('SSH payload checksum mismatch')
exec(compile(source, '<verify-android>', 'exec'))`
  const quoted = "'" + launcher.replaceAll("'", "'\\''") + "'"
  const child = NodeChildProcess.spawn(
    'ssh',
    ['-o', 'ConnectTimeout=20', alias, 'python3', '-c', quoted, verb, alias, hosts[alias]],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const closed = NodeEvents.once(child, 'close')
  child.stdin.end(source)
  const [code] = await closed
  return code === null ? 1 : code
}

const started = performance.now()
let code = await remote('./android.py', action)
if (code === 0 && action === 'provision') {
  code = await remote('./tools.py', action)
  if (code !== 0) await remote('./android.py', 'stop')
}
console.error(
  JSON.stringify({ action, alias, wallSeconds: (performance.now() - started) / 1000, code }),
)
process.exitCode = code
