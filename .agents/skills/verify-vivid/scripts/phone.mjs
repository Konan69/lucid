import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodeAssert from 'node:assert/strict'
import { command, json, alive } from './process.mjs'
import { host } from './settings.mjs'
import { control } from './socket.mjs'
import { apk, phoneEnvironment, phoneOrigin } from './apk.mjs'
import { phoneCleanup } from './phonecleanup.mjs'
import { readAccount, readDevice, readState } from './phonewire.mjs'
import { rpc } from './wire.mjs'

const cache = NodeOS.homedir() + '/.cache/vivid-android'
const cli = [
  cache + '/node/bin/node',
  cache + '/tools/node_modules/agent-device/bin/agent-device.mjs',
]

/** Re-snapshot before every interaction. Refs are selected from the current accessibility tree,
 * never remembered across a transition or guessed from screen coordinates. */
async function target(run, label) {
  await run(['wait', 'text', label, '60000'])
  const snapshot = await run(['snapshot', '-i'])
  const lines = snapshot.split('\n').filter((line) => line.includes(label) && /@e\d+/u.test(line))
  NodeAssert.equal(lines.length, 1, 'Expected one interactive ref for ' + label + '\n' + snapshot)
  return lines[0].match(/@e\d+/u)[0]
}

/** The ordinary email controls authenticate the same disposable Person the public proof uses.
 * agent-device state stays private because its journal can include synthetic form values. */
async function enter(state, run) {
  const account = Result.getOrThrow(
    readAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  await run(['press', await target(run, 'Log in')])
  // Android's interactive snapshot names the input by its visible placeholder.
  await run(['fill', await target(run, 'name@example.com'), account.email])
  await run(['press', await target(run, 'Continue')])
  await run(['fill', await target(run, 'Password'), account.password], [account.password])
  await run(['press', await target(run, 'Sign in')])
  await run(['wait', 'text', 'Open menu', '60000'])
}

/** Idle Thread navigation isolates Android rendering and authentication from model behaviour.
 * A public CreateThread/GetThread receipt seeds and confirms the same Thread selected in the UI. */
async function journey(state, run, directory) {
  const id = crypto.randomUUID()
  const title = 'Phone verification ' + state.run.slice(-8)
  await rpc(state, 'CreateThread', { id, title, projectId: null }, directory, 'create-thread')
  await run(['open', 'work.vivid.mobile', '--relaunch'])
  await enter(state, run)
  await run(['press', await target(run, 'Open menu')])
  await run(['wait', 'text', title, '60000'])
  await run(['snapshot', '-i'])
  await run(['screenshot', directory + '/threads.png'])
  await run(['press', await target(run, title)])
  await run(['wait', 'text', 'Message Vivid', '60000'])
  await run(['wait', 'text', title, '60000'])
  await run(['snapshot', '-i'])
  await run(['screenshot', directory + '/thread.png'])
  const detail = await rpc(state, 'GetThread', { id }, directory, 'idle-thread')
  NodeAssert.equal(detail.thread.id, id)
  NodeAssert.equal(detail.runs.length, 0, 'The idle journey must not start model work')
  return { id, title }
}

/** One phone command owns the host lease until finally has closed its session and stopped the
 * captured emulator. A killed worker leaves acquisition receipts for verify cleanup. */
export async function phone(state, feature) {
  NodeAssert.equal(feature, 'thread', 'No phone recipe for ' + feature)
  await host()
  NodeAssert.equal(state.dirty, false, 'Phone APK proof requires a clean committed checkout')
  const directory = state.evidence + '/phone'
  await NodeFSP.mkdir(directory, { recursive: true })
  const device = Result.getOrThrow(
    readDevice(await NodeFSP.readFile(cache + '/device.json', 'utf8')),
  )
  NodeAssert.equal(device.hostname, state.hostname)
  NodeAssert.equal(device.alias, state.devbox)
  NodeAssert.ok(await alive(device.emulator), 'Run verify android provision before phone')
  NodeAssert.ok(await alive(device.adb), 'Owned adb is not alive')
  const lease = cache + '/lease.json'
  const prior = await NodeFSP.stat(lease).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (prior !== null)
    throw new Error('A proof run owns this emulator; clean it before another phone journey')
  const receipt = {
    run: state.run,
    stateDir: state.scratch + '/device',
    session: state.run,
    device,
  }
  await json(lease, receipt)
  await json(state.scratch + '/phone.json', receipt)
  await json(directory + '/receipt.json', receipt)
  const env = { ...phoneEnvironment, AGENT_DEVICE_STATE_DIR: receipt.stateDir }
  let count = 0
  const execute = (argv, redactions = []) =>
    command(argv, {
      env,
      redactions,
      log: directory + '/' + String(++count).padStart(3, '0') + '.json',
      record: (process) => control(state, { action: 'capture', process }),
    })
  const run = (args, redactions) =>
    execute(
      [
        ...cli,
        ...args,
        '--platform',
        'android',
        '--serial',
        device.serial,
        '--session',
        receipt.session,
      ],
      redactions,
    )
  let verdict
  try {
    const artifact = await apk(state, (process) => control(state, { action: 'capture', process }))
    await json(directory + '/apk.json', artifact)
    const adb = device.sdk + '/platform-tools/adb'
    await execute([adb, '-s', device.serial, 'install', '-r', artifact.file])
    await execute([adb, '-s', device.serial, 'shell', 'pm', 'clear', 'work.vivid.mobile'])
    await execute([adb, '-s', device.serial, 'reverse', 'tcp:19278', 'tcp:' + state.ports.web])
    await execute([...cli, 'doctor', '--platform', 'android'])
    const thread = await journey(state, run, directory)
    verdict = { verdict: 'proved', thread, apk: artifact }
  } catch (error) {
    verdict = { verdict: 'failed', error: error.stack }
    throw error
  } finally {
    await json(directory + '/verdict.json', {
      ...verdict,
      feature: 'features/phone.md',
      head: state.head,
      dirty: state.dirty,
      tree: state.tree,
      diffHash: state.diffHash,
      model: state.model,
      modelKind: state.modelKind,
      claim: 'idle native navigation; no model behaviour',
      alias: state.devbox,
      hostname: state.hostname,
      serial: device.serial,
      origin: phoneOrigin,
      evidence: directory,
    })
    await phoneCleanup(state)
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  await phone(
    Result.getOrThrow(readState(await NodeFSP.readFile(process.argv[2], 'utf8'))),
    process.argv[3],
  )
