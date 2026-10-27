import { Result, Schema } from 'effect'
import { decodeText } from './receipts.mjs'
import * as NodeFSP from 'node:fs/promises'
import { alive, ownsPort, command, checkout } from './process.mjs'
import { owned, sameBoot } from './recovery.mjs'
import { readPhone, readApk } from './phonewire.mjs'
import { equivalent } from './apk.mjs'
import { cellSnapshot } from './cells.mjs'

const ExecutorInspections = Schema.Array(
  Schema.Struct({
    State: Schema.Struct({
      Running: Schema.Boolean,
      Health: Schema.Struct({ Status: Schema.String }),
    }),
    Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    HostConfig: Schema.Struct({ NetworkMode: Schema.String }),
  }),
)

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
  await check('disposable Executor', async () => {
    const [value] = decodeText(
      ExecutorInspections,
      await command(['docker', 'inspect', state.executorContainer]),
    )
    return {
      ok:
        value.State.Running &&
        value.State.Health.Status === 'healthy' &&
        value.Config.Labels['vivid.verify'] === state.run &&
        value.HostConfig.NetworkMode === 'host',
    }
  })
  for (const role of ['supervisor', 'server', 'web', 'runtime', 'runtime-peer'])
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
  await nativeCells(state, check)
  await check('native Worker health', async () => {
    if (!currentBoot || !(await ownsPort(state.processes.runtime, state.ports.runtime)))
      return { ok: false, reason: 'No owned runtime listener' }
    const { status } = await import('./wire.mjs')
    const value = await status(state)
    return { ok: value.service === 'vivid-cells' && value.status === 'ok', status: value }
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
      head: state.head,
      sourceHead: artifact.head,
    }
    return {
      ok: await equivalent(state.head, artifact),
      ...phone,
    }
  })
  return phone
}

/** Person activation must traverse the real product gateway after native deployment. */
async function nativeCells(state, check) {
  await check('disposable fleet bucket', async () => {
    const output = await command([
      'docker',
      'inspect',
      '--format',
      '{{.State.Running}} {{.State.Health.Status}} {{index .Config.Labels "vivid.verify"}} {{range (index .NetworkSettings.Ports "9000/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}',
      state.bucketContainer,
    ])
    return { ok: output === `true healthy ${state.run} 127.0.0.1:${state.ports.bucket}` }
  })
  await check('native cell deployment', async () => ({
    ok: true,
    fleet: await cellSnapshot(state),
  }))
  await check('native Person activation', async () => {
    if (!state.cellProbe) return { ok: false, reason: 'No native Person activation receipt' }
    const { history } = await import('./wire.mjs')
    const page = await history(state, state.cellProbe, state.evidence, 'doctor-cell-history')
    return { ok: page.messages.length === 0, thread: state.cellProbe }
  })
}
