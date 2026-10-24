import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import { identity, root, json } from './process.mjs'
import { control } from './socket.mjs'

// xdg-open's private default browser. The normal shell handoff opens real Chrome, on Xvfb.
const [manifest, address] = process.argv.slice(2)
const state = JSON.parse(await NodeFSP.readFile(manifest, 'utf8'))
const log = await NodeFSP.open(state.scratch + '/desktop-browser.log', 'a', 0o600)
const child = NodeChildProcess.spawn(
  process.env.VIVID_VERIFY_CHROME ?? '/opt/google/chrome/chrome',
  [
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + state.scratch + '/desktop-browser-profile',
    address,
  ],
  { cwd: root, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] },
)
try {
  const owned = await identity(child.pid)
  await json(state.scratch + '/desktop-external.json', { process: owned, address })
  await control(state, { action: 'capture', process: owned })
} finally {
  child.unref()
  await log.close()
}
