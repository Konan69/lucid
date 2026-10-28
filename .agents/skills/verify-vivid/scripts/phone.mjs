import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodeChildProcess from 'node:child_process'
import * as NodeAssert from 'node:assert/strict'
import { command, json, alive, identity } from './process.mjs'
import { host } from './settings.mjs'
import { control } from './socket.mjs'
import { apk, phoneEnvironment, phoneOrigin } from './apk.mjs'
import { phoneCleanup } from './phonecleanup.mjs'
import { stopCaptured } from './recovery.mjs'
import { readAccount, readDevice, readState } from './phonewire.mjs'
import { rpc, history } from './wire.mjs'
import { phoneUI } from './phoneui.mjs'
import * as flows from './phoneflow.mjs'
import { approval } from './phoneapproval.mjs'
import { memory, settingsMemory, learning } from './phonememory.mjs'

const cache = NodeOS.homedir() + '/.cache/vivid-android'
const cli = [
  cache + '/node/bin/node',
  cache + '/tools/node_modules/agent-device/bin/agent-device.mjs',
]

/** Authenticate through Android's email form using this run's synthetic Person. */
async function enter(state, ui) {
  const account = Result.getOrThrow(
    readAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  await ui.run(['open', 'work.vivid.mobile', '--relaunch'])
  await ui.press('Log in')
  await ui.fill('name@example.com', account.email)
  await ui.press('Continue')
  await ui.fill('Password', account.password, [account.password])
  await ui.press('Sign in')
  await ui.visible('Open menu')
  return account
}

/** Idle navigation proves the actual phone's held BePresent, separately from model journeys. */
async function thread(state, id, ui) {
  const account = Result.getOrThrow(
    readAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  await ui.menu()
  await ui.capture('threads')
  await ui.visit(id)
  await ui.capture('thread')
  const detail = await rpc(state, 'GetThread', { id }, ui.directory, 'idle-thread')
  NodeAssert.equal(detail.thread.id, id)
  NodeAssert.equal(detail.runs.length, 0)
  NodeAssert.ok(detail.present.some((seen) => seen.person.id === account.person))
}

const recipes = {
  thread,
  send: flows.send,
  replies: flows.replies,
  question: flows.question,
  approve: (state, id, ui) => approval(state, id, ui, true),
  deny: (state, id, ui) => approval(state, id, ui, false),
  stop: flows.stop,
  picture: flows.picture,
  memory,
  'settings-memory': settingsMemory,
  learning,
  feed: flows.feed,
  move: flows.move,
}

/** Each recipe gets its own evidence, even when an earlier recipe or native renderer fails. */
async function journey(state, name, ui, native) {
  let verdict
  let id
  try {
    if (!(await alive(native.device.emulator))) {
      await json(ui.directory + '/verdict.json', {
        verdict: 'blocked',
        journey: name,
        head: state.head,
        run: state.run,
        model: state.model,
        reason: 'Captured emulator exited during an earlier journey',
        evidence: ui.directory,
      })
      return { verdict: 'blocked', journey: name }
    }
    await ui.run(['open', 'work.vivid.mobile', '--foreground'])
    if (name !== 'thread')
      NodeAssert.equal(state.modelKind, 'real', 'Phone journey requires a real model')
    id = await ui.create('Phone ' + name + ' ' + crypto.randomUUID().slice(0, 8))
    await recipes[name](state, id, ui, native.adb)
    verdict = { verdict: 'proved', thread: id }
  } catch (error) {
    verdict = { verdict: 'failed', thread: id, error: error.stack }
    if (id) {
      await rpc(state, 'GetThread', { id }, ui.directory, 'failed-thread').catch(() => {})
      await history(state, id, ui.directory, 'failed-history').catch(() => {})
    }
    if (await alive(native.device.emulator)) await ui.capture('failure').catch(() => {})
    else await json(ui.directory + '/emulator-exited.json', native.device)
  }
  await json(ui.directory + '/verdict.json', {
    ...verdict,
    journey: name,
    feature: 'features/phone.md',
    head: state.head,
    dirty: state.dirty,
    tree: state.tree,
    diffHash: state.diffHash,
    model: state.model,
    modelKind: state.modelKind,
    alias: state.devbox,
    hostname: state.hostname,
    run: state.run,
    evidence: ui.directory,
    claim: name === 'thread' ? 'idle native navigation; no model behaviour' : 'Android ' + name,
  })
  return verdict
}

/** A captured collector preserves guest logs before a renderer failure can remove the serial.
 * Post-crash adb reads wait indefinitely, so cleanup stops this already-recording generation. */
async function logcat(state, { adb, serial, env, directory }) {
  const log = await NodeFSP.open(directory + '/logcat.log', 'a', 0o600)
  try {
    const collector = NodeChildProcess.spawn(
      adb,
      ['-s', serial, 'logcat', '-v', 'threadtime', '*:W', 'ReactNativeJS:V'],
      { env, stdio: ['ignore', log.fd, log.fd], detached: true },
    )
    const recording = await identity(collector.pid)
    await control(state, { action: 'capture', process: recording })
    return recording
  } finally {
    await log.close()
  }
}

/** One phone command owns the host lease until finally has closed its session and stopped the
 * captured emulator. A killed worker leaves acquisition receipts for verify cleanup. */
export async function phone(state, feature) {
  const chosen = feature === 'all' ? Object.keys(recipes) : [feature]
  NodeAssert.ok(
    chosen.every((name) => Object.hasOwn(recipes, name)),
    'No phone recipe for ' + feature,
  )
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
  let logDirectory = directory
  const execute = (argv, redactions = []) =>
    command(argv, {
      env,
      redactions,
      log: logDirectory + '/' + String(++count).padStart(3, '0') + '.json',
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
  let recording
  try {
    const artifact = await apk(state, (process) => control(state, { action: 'capture', process }))
    await json(directory + '/apk.json', artifact)
    const adb = device.sdk + '/platform-tools/adb'
    await execute([adb, '-s', device.serial, 'install', '-r', artifact.file])
    await execute([adb, '-s', device.serial, 'shell', 'pm', 'clear', 'work.vivid.mobile'])
    await execute([adb, '-s', device.serial, 'reverse', 'tcp:19278', 'tcp:' + state.ports.web])
    await execute([...cli, 'doctor', '--platform', 'android'])
    const adbRun = (args) => execute([adb, '-s', device.serial, ...args])
    recording = await logcat(state, { adb, serial: device.serial, env, directory })
    await enter(state, phoneUI(state, run, directory))
    const journeys = []
    for (const name of chosen) {
      logDirectory = directory + '/' + name
      await NodeFSP.mkdir(logDirectory, { recursive: true })
      journeys.push(
        await journey(state, name, phoneUI(state, run, logDirectory), { adb: adbRun, device }),
      )
    }
    verdict = {
      verdict: journeys.every((entry) => entry.verdict === 'proved') ? 'proved' : 'failed',
      journeys,
      apk: artifact,
    }
    if (verdict.verdict !== 'proved') process.exitCode = 1
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
      claim:
        feature === 'thread'
          ? 'idle native navigation; no model behaviour'
          : 'Android journeys; see per-journey verdicts',
      alias: state.devbox,
      hostname: state.hostname,
      serial: device.serial,
      origin: phoneOrigin,
      evidence: directory,
    })
    if (recording) await stopCaptured(recording, true)
    if (await alive(device.emulator)) await run(['close', 'work.vivid.mobile']).catch(() => {})
    await phoneCleanup(state)
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  await phone(
    Result.getOrThrow(readState(await NodeFSP.readFile(process.argv[2], 'utf8'))),
    process.argv[3],
  )
