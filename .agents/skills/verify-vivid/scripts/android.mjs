import * as fs from 'node:fs/promises'
import * as child from 'node:child_process'

/** Provision needs no app dependencies, so it also works before a fresh checkout's install. */
const [action, alias] = process.argv.slice(2)
const hosts = JSON.parse(await fs.readFile(new URL('./hosts.json', import.meta.url), 'utf8'))
if (!Object.hasOwn(hosts, alias) || !['provision', 'stop', 'status'].includes(action))
  throw new Error('verify android provision|stop|status <devbox-pick alias>')
const source = await fs.readFile(new URL('./android.py', import.meta.url))
const ssh = child.spawn('ssh', [alias, 'python3', '-', action, alias, hosts[alias]], {
  stdio: ['pipe', 'inherit', 'inherit'],
})
ssh.stdin.end(source)
ssh.on('error', (error) => {
  throw error
})
ssh.on('exit', async (code) => {
  process.exitCode = code === null ? 1 : code
  if (code !== 0 || action !== 'provision') return
  const source = await fs.readFile(new URL('./tools.py', import.meta.url))
  const tools = child.spawn('ssh', [alias, 'python3', '-'], {
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  tools.stdin.end(source)
  tools.on('error', (error) => {
    throw error
  })
  tools.on('exit', (status) => {
    process.exitCode = status === null ? 1 : status
  })
})
