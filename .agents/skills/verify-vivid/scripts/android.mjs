import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
import { hosts } from './hosts.mjs'

const [action, alias] = process.argv.slice(2)
if (!Object.hasOwn(hosts, alias) || !['provision', 'stop', 'status'].includes(action))
  throw new Error('verify android provision|stop|status <devbox-pick alias>')

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
