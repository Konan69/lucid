import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import { command, json, alive } from './process.mjs'
import { stopCaptured } from './recovery.mjs'
import { readPhone } from './phonewire.mjs'

/** Both normal completion and abandoned-run recovery use the same captured device generations.
 * The private agent-device daemon verifies its own PID receipt through its public stop command. */
export async function phoneCleanup(state) {
  const acquisition = await phoneAcquisition(state)
  if (acquisition === null) return
  const { home, cache, leasePath, phone } = acquisition
  const directory = state.evidence + '/phone'
  const env = {
    ...process.env,
    HOME: home,
    AGENT_DEVICE_STATE_DIR: phone.stateDir,
    PATH: cache + '/node/bin:' + phone.device.sdk + '/platform-tools:' + process.env.PATH,
    ANDROID_ADB_SERVER_PORT: '15037',
  }
  const cli = [
    cache + '/node/bin/node',
    cache + '/tools/node_modules/agent-device/bin/agent-device.mjs',
  ]
  const failures = []
  const daemon = await NodeFSP.stat(phone.stateDir + '/daemon.json').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (daemon !== null) {
    try {
      await command([...cli, 'daemon', 'stop', '--clean', '--state-dir', phone.stateDir], {
        env,
        log: directory + '/cleanup-daemon.json',
      })
    } catch (error) {
      failures.push(error.message)
    }
  }
  await reverseCleanup({ phone, env, directory, port: state.ports.web }, failures)
  const stopped = []
  for (const role of ['emulator', 'adb']) stopped.push(await stopCaptured(phone.device[role], true))
  const status = await command(
    [
      'ps',
      '-p',
      String(phone.device.emulator.pid) + ',' + phone.device.adb.pid,
      '-o',
      'pid,ppid,args',
    ],
    { log: directory + '/ps-cleanup.json' },
  ).catch((error) => error.message)
  const surviving = (await alive(phone.device.emulator)) || (await alive(phone.device.adb))
  await json(directory + '/cleanup.json', { stopped, surviving, status, failures })
  if (surviving || failures.length)
    throw new Error('Phone cleanup failed; inspect ' + directory + '/cleanup.json')
  await NodeFSP.rm(state.scratch + '/phone.json', { force: true })
  await NodeFSP.rm(leasePath, { force: true })
}

/** Reverse mappings belong to this disposable emulator and must disappear before its adb stops. */
async function reverseCleanup({ phone, env, directory, port }, failures) {
  if (!(await alive(phone.device.adb))) return
  try {
    const adb = [phone.device.sdk + '/platform-tools/adb', '-s', phone.device.serial, 'reverse']
    const listing = await command([...adb, '--list'], {
      env,
      log: directory + '/reverse-list.json',
    })
    const mapping = listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/u))
      .find((fields) => fields[1] === 'tcp:19278')
    if (mapping === undefined) return
    if (mapping[2] !== 'tcp:' + port) throw new Error('Phone reverse mapping ownership mismatch')
    await command([...adb, '--remove', 'tcp:19278'], {
      env,
      log: directory + '/reverse-cleanup.json',
    })
  } catch (error) {
    failures.push(error.message)
  }
}

/** The host lease is the acquisition journal if a worker dies before its private copy is written. */
async function phoneAcquisition(state) {
  // The supervisor isolates HOME in scratch; the OS account owns the rebuildable host cache.
  const home = NodeOS.userInfo().homedir
  const cache = home + '/.cache/vivid-android'
  const leasePath = cache + '/lease.json'
  const read = (file) =>
    NodeFSP.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const leaseText = await read(leasePath)
  const lease = leaseText === null ? null : Result.getOrThrow(readPhone(leaseText))
  const text = await read(state.scratch + '/phone.json')
  if (text === null && (lease === null || lease.run !== state.run)) return null
  const phone = text === null ? lease : Result.getOrThrow(readPhone(text))
  if (lease !== null && lease.run !== state.run) throw new Error('Phone lease ownership mismatch')
  if (
    phone.run !== state.run ||
    phone.session !== state.run ||
    phone.stateDir !== state.scratch + '/device'
  )
    throw new Error('Phone ownership mismatch')
  return { home, cache, leasePath, phone }
}
