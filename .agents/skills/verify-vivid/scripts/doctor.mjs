import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import { alive, ownsPort, command, checkout } from './process.mjs'
import { owned, sameBoot } from './recovery.mjs'
import { readPhone, readApk } from './phonewire.mjs'
import { apkHash } from './apk.mjs'

/** Read-only checks record individual missing resources instead of throwing on partial/crashed
 * state. Network probes run only for listeners owned by this run; Doctor never starts anything. */
export async function doctor(state) {
  await owned(state)
  const checks = []
  const currentBoot = await sameBoot(state)
  const check = async (name, read) => {
    try {
      const result = await read()
      checks.push({ check: name, ...result })
    } catch (error) {
      checks.push({ check: name, ok: false, error: error.message })
    }
  }
  await check('checkout commit', async () => ({
    ok: (await command(['git', 'rev-parse', 'HEAD'])) === state.head,
  }))
  await check('checkout tree', async () => {
    const current = await checkout()
    return { ok: current.tree === state.tree && current.diffHash === state.diffHash, ...current }
  })
  await check('disposable Helix', async () => {
    const value = JSON.parse(await command(['docker', 'inspect', state.helixContainer]))[0]
    const binding = value.NetworkSettings.Ports['8080/tcp']
    return {
      ok:
        value.State.Running &&
        value.Config.Labels['vivid.verify'] === state.run &&
        binding.some((b) => b.HostIp === '127.0.0.1' && Number(b.HostPort) === state.ports.helix),
    }
  })
  for (const role of ['supervisor', 'server', 'web', 'runtime'])
    await check(role + ' process', async () => ({
      ok: currentBoot && (await alive(state.processes[role])),
      process: state.processes[role],
    }))
  for (const role of ['server', 'web', 'runtime'])
    await check(role + ' owns port', async () => ({
      ok: currentBoot && (await ownsPort(state.processes[role], state.ports[role])),
    }))
  let containerOwned = false
  await check('disposable container port/name ownership', async () => {
    const container = JSON.parse(await command(['docker', 'inspect', state.container]))[0]
    const bindings = container.NetworkSettings.Ports['5432/tcp']
    containerOwned =
      container.Config.Labels['vivid.verify'] === state.run &&
      Array.isArray(bindings) &&
      bindings.some(
        (binding) =>
          binding.HostIp === '127.0.0.1' && Number(binding.HostPort) === state.ports.database,
      )
    return { ok: containerOwned, running: container.State.Running }
  })
  await check('disposable database', async () => {
    if (!containerOwned) return { ok: false, reason: 'No owned disposable container' }
    const output = await command([
      'docker',
      'exec',
      state.container,
      'pg_isready',
      '-U',
      'verify',
      '-d',
      'verify',
    ])
    return { ok: output.includes('accepting connections'), output }
  })
  await check('Flue selected runtime', async () => {
    if (!currentBoot || !(await ownsPort(state.processes.runtime, state.ports.runtime)))
      return { ok: false, reason: 'No owned runtime listener' }
    const { status } = await import('./wire.mjs')
    const value = await status(state)
    return { ok: value.model === state.model && value.status === 'ok', status: value }
  })
  await check('single-origin health', async () => {
    if (!currentBoot || !(await ownsPort(state.processes.web, state.ports.web)))
      return { ok: false, reason: 'No owned web listener' }
    const response = await fetch(state.web + '/health', { signal: AbortSignal.timeout(5000) })
    const value = await response.json()
    return {
      ok: response.status === 200 && value.ok === true && value.service === 'vivid',
      status: response.status,
      health: value,
    }
  })
  const phone = await phoneIdentity(state, check)
  const result = {
    worthy: checks.every((value) => value.ok),
    head: state.head,
    dirty: state.dirty,
    diffHash: state.diffHash,
    tree: state.tree,
    model: state.model,
    host: state.hostname,
    devbox: state.devbox,
    phone,
    checks,
  }
  await NodeFSP.writeFile(state.evidence + '/doctor.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (!result.worthy) process.exitCode = 1
}

/** The APK identity is independent from server health and stays inspectable after device stop. */
async function phoneIdentity(state, check) {
  const receipt = await NodeFSP.readFile(state.evidence + '/phone/receipt.json', 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (receipt === null) return null
  let phone
  await check('Android APK identity', async () => {
    const acquired = Result.getOrThrow(readPhone(receipt))
    const artifact = Result.getOrThrow(
      readApk(await NodeFSP.readFile(state.evidence + '/phone/apk.json', 'utf8')),
    )
    phone = {
      alias: acquired.device.alias,
      hostname: acquired.device.hostname,
      serial: acquired.device.serial,
      sha256: artifact.sha256,
      head: artifact.head,
    }
    return {
      ok: artifact.head === state.head && artifact.sha256 === (await apkHash(artifact.file)),
      ...phone,
    }
  })
  return phone
}
