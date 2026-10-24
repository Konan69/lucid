import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import { identity, root, json } from './process.mjs'
import { control } from './socket.mjs'

/** Capture each native process before readiness. Its stdout/stderr owns the readiness signal. */
export async function start(state, receipt, { argv, env, pattern, name }) {
  const log = await NodeFSP.open(state.evidence + '/desktop/' + name + '.log', 'a', 0o600)
  const child = NodeChildProcess.spawn(argv[0], argv.slice(1), {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  let timer
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(name + ' readiness deadline')), 120_000)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(name + ' exited ' + code)))
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        text += data
        void log.write(data)
        const found = pattern.exec(text)
        if (found) resolve(found[1])
      })
  }).finally(() => clearTimeout(timer))
  void ready.catch(() => {})
  child.once('close', () => {
    void log.close()
  })
  const owned = await identity(child.pid)
  receipt.processes.push(owned)
  await json(state.scratch + '/desktop.json', receipt)
  await control(state, { action: 'capture', process: owned })
  return { child, owned, ready }
}

/** The OS opener remains xdg-open; only its default browser/profile belong to this run. */
export async function environment(state) {
  const executable = state.scratch + '/desktop-browser'
  // Launcher paths become shell words; reject metacharacters before writing the wrapper.
  const paths = [process.execPath, root, state.evidence, executable]
  if (paths.some((path) => /[^a-zA-Z0-9/_.-]/u.test(path)))
    throw new Error('Desktop launcher requires ordinary path characters')
  await NodeFSP.writeFile(
    executable,
    '#!/bin/sh\nexec ' +
      process.execPath +
      ' ' +
      root +
      '/.agents/skills/verify-vivid/scripts/desktopopen.mjs ' +
      state.evidence +
      '/state.json "$@"\n',
    { mode: 0o700 },
  )
  const config = state.scratch + '/desktop-config'
  const data = state.scratch + '/desktop-data'
  await NodeFSP.mkdir(config, { recursive: true })
  await NodeFSP.mkdir(data + '/applications', { recursive: true })
  await NodeFSP.writeFile(
    data + '/applications/vivid-verify.desktop',
    '[Desktop Entry]\nType=Application\nName=Verification browser\nExec=' +
      executable +
      ' %u\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n',
  )
  await NodeFSP.writeFile(
    config + '/mimeapps.list',
    '[Default Applications]\nx-scheme-handler/http=vivid-verify.desktop\nx-scheme-handler/https=vivid-verify.desktop\n',
  )
  return {
    PATH: process.env.PATH,
    HOME: state.scratch,
    LANG: 'C.UTF-8',
    BROWSER: executable,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    VIVID_VERIFY_CHROME: process.env.VIVID_VERIFY_CHROME ?? '/opt/google/chrome/chrome',
  }
}
