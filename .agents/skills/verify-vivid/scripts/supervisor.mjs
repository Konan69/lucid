import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeNet from 'node:net'
import * as NodePath from 'node:path'
import * as NodeCrypto from 'node:crypto'
import * as NodeModule from 'node:module'
import {
  command,
  identity,
  signal,
  terminate,
  runningCommands,
  root,
  skill,
  alive,
  json,
} from './process.mjs'
import { stopCaptured } from './recovery.mjs'
import { remoteCleanup } from './remote.mjs'
import { phoneCleanup } from './phonecleanup.mjs'
import { executor } from './executor.mjs'
import { authSecret } from './settings.mjs'
import { decodeText, RuntimeHealth } from './receipts.mjs'
import { startCells, cellControl, cellSnapshot } from './cells.mjs'
import { rpc, history } from './wire.mjs'
const require = NodeModule.createRequire(root + '/apps/server/package.json')
const state = JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8'))
const children = new Map()
let serverChild
let control
let cleaning = false
let cleanupPromise
let writes = Promise.resolve()
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: state.scratch,
  LANG: 'C.UTF-8',
  DO_NOT_TRACK: '1',
  OTEL_SDK_DISABLED: 'true',
  COREPACK_HOME: process.env.COREPACK_HOME,
  COREPACK_ENABLE_NETWORK: '0',
}
const databaseUrl = () => `postgres://verify:verify@127.0.0.1:${state.ports.database}/verify`

/** Command processes (including a queued flock) are journaled too, so a crashed supervisor
 * cannot strand its own migration/build/cleanup command. Never discover processes by pattern. */
const run = (argv, options = {}) =>
  command(argv, {
    ...options,
    record: async (receipt) => {
      if (!state.commands) state.commands = {}
      state.commands[receipt.pid] = receipt
      await save()
    },
  })

/** Journal the capture before waiting for startup; even failed attempts remain cleanable. */
function save() {
  // Concurrent captures serialize against the latest journal, so an earlier filesystem
  // completion cannot overwrite a later PID receipt.
  writes = writes.then(() => json(state.evidence + '/state.json', state))
  return writes
}
/** Capture the spawned child and buffer readiness before any waiter can miss an early event. */
async function own(role, argv, options = {}) {
  const log = await NodeFSP.open(state.evidence + '/' + role + '.log', 'a', 0o600)
  const child = NodeChildProcess.spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: cleanEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  children.set(role, child)
  const output = []
  child.observed = { data: output, output, message: [] }
  child.stdout?.on('data', (bytes) => {
    child.observed.data.push(bytes)
    child.emit('output', bytes)
    log.write(bytes)
  })
  child.stderr?.on('data', (bytes) => {
    child.observed.data.push(bytes)
    child.emit('output', bytes)
    log.write(bytes)
  })
  child.on('message', (value) => child.observed.message.push(value))
  child.once('close', () => log.close())
  state.processes[role] = { ...(await identity(child.pid)), command: argv }
  await save()
  return child
}

/** Exercise real Better Auth signup and signin; keep the synthetic cookie and password in disposable scratch. */
async function signedIn() {
  const email = state.run + '@example.test'
  const password = 'Verify!Local-0123456789'
  const body = { name: 'Verification Person', email, password }
  const headers = { origin: state.web, 'content-type': 'application/json' }
  const signup = await fetch(state.server + '/api/auth/sign-up/email', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const created = await signup.json()
  await json(state.evidence + '/sign-up.json', { status: signup.status, user: created.user })
  if (signup.status !== 200) throw new Error('Sign-up failed: ' + signup.status)
  const signin = await fetch(state.server + '/api/auth/sign-in/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  })
  const entered = await signin.json()
  if (signin.status !== 200) throw new Error('Sign-in failed: ' + signin.status)
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error('Better Auth returned no session cookie')
  await json(state.scratch + '/account.json', { person: entered.user.id, email, password, cookie })
  await json(state.evidence + '/sign-in.json', { status: signin.status, user: entered.user })
  state.person = entered.user.id
  await save()
  return entered.user.id
}

/** Docker's health_status event is readiness. There is no delay loop or readiness-by-timeout. */
async function database() {
  const names = await run(['docker', 'ps', '-a', '--format', '{{.Names}}'])
  if (names.split('\n').includes(state.container))
    throw new Error('Container already exists: ' + state.container)
  state.containerCreated = true
  await save()
  await run(
    [
      'docker',
      'run',
      '--detach',
      '--name',
      state.container,
      '--label',
      'vivid.verify=' + state.run,
      '-e',
      'POSTGRES_USER=verify',
      '-e',
      'POSTGRES_PASSWORD=verify',
      '-e',
      'POSTGRES_DB=verify',
      '-p',
      `127.0.0.1:${state.ports.database}:5432`,
      // TCP, not the socket: the image's first-boot init server answers on the socket only and
      // then restarts, so a socket check passes before the real server accepts connections.
      '--health-cmd',
      'pg_isready -h 127.0.0.1 -U verify -d verify',
      '--health-interval',
      '1s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      'postgres:18-alpine',
    ],
    { heavy: true, log: state.evidence + '/docker.json' },
  )
  const health = await run([
    'docker',
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    state.container,
  ])
  if (health !== 'healthy') {
    const events = await own('database-events', [
      'docker',
      'events',
      '--since',
      state.started,
      '--filter',
      'container=' + state.container,
      '--filter',
      'event=health_status',
      '--format',
      '{{.Action}}',
    ])
    try {
      await signal(
        events,
        events.stdout,
        'data',
        (bytes) => bytes.toString().includes('health_status: healthy'),
        60_000,
      )
    } finally {
      events.kill('SIGTERM')
      await NodeEvents.once(events, 'close')
    }
  }
  const env = { ...cleanEnv, DATABASE_URL: databaseUrl(), VIVID_TEST_DATABASE_URL: databaseUrl() }
  for (const name of ['db:migrate', 'db:migrate:product'])
    await run(['pnpm', '--filter', '@vivid/server', name], {
      env,
      heavy: true,
      log: state.evidence + '/' + name.replace(':', '-') + '.json',
    })
}

/** The product entry exposes HTTP health but no IPC readiness receipt. Launch probes that
 * route; elapsed time alone never establishes readiness. Feature checks use WatchThread signals. */
async function serverReady(child) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Product server exited before health')
    try {
      const response = await fetch(state.server + '/health', { signal: AbortSignal.timeout(2000) })
      if (response.ok && (await response.json()).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Product server health deadline')
}

/** Helix has no configured Docker health event. Launch waits for a successful read-only query. */
async function helix() {
  state.helixCreated = true
  await save()
  await run(
    [
      'docker',
      'run',
      '--detach',
      '--name',
      state.helixContainer,
      '--label',
      'vivid.verify=' + state.run,
      '-e',
      'HELIX_DATA_DIR=/var/lib/helix',
      '-e',
      'HELIX_HTTP_ADDR=0.0.0.0:8080',
      '-p',
      `127.0.0.1:${state.ports.helix}:8080`,
      'ghcr.io/helixdb/helixdb:v0.0.5',
    ],
    { heavy: true, log: state.evidence + '/helix-docker.json' },
  )
  const { readBatch, g } = await import(require.resolve('@helix-db/helix-db'))
  const probe = readBatch()
    .varAs('probe', g().nWithLabel('VerifyReadiness').limit(1))
    .returning(['probe'])
    .toQueryJson()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.ports.helix}/v2/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: probe,
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        await json(state.evidence + '/helix-health.json', {
          status: response.status,
          body: await response.text(),
        })
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Disposable Helix health deadline')
}

async function launch() {
  await ownReceipt()
  await database()
  await helix()
  state.web = `http://127.0.0.1:${state.ports.web}`
  state.server = `http://127.0.0.1:${state.ports.server}`
  const executorEnv = await executor(state, { run, own, save, cleanEnv })
  const token = crypto.randomUUID()
  await NodeFSP.writeFile(state.scratch + '/runtime-token', token, { mode: 0o600 })
  const providerText = await NodeFSP.readFile(state.scratch + '/provider.json', 'utf8')
  await NodeFSP.unlink(state.scratch + '/provider.json')
  const provider = JSON.parse(providerText)
  const curve = NodeCrypto.createECDH('prime256v1')
  curve.generateKeys()
  const env = {
    ...cleanEnv,
    ...provider,
    DATABASE_URL: databaseUrl(),
    VIVID_TEST_DATABASE_URL: databaseUrl(),
    AUTH_SECRET: authSecret,
    PORT: String(state.ports.server),
    VIVID_RUNTIME_URL: `http://127.0.0.1:${state.ports.runtime}`,
    VIVID_SERVER_URL: state.server,
    VIVID_RUNTIME_TOKEN: token,
    VIVID_MODEL: state.model,
    VIVID_HELIX_URL: `http://127.0.0.1:${state.ports.helix}`,
    VIVID_BUILD_COMMIT: state.head,
    VIVID_BOAT_API_KEY: 'unconfigured-disposable-verification',
    VIVID_BOAT_TEMPLATE: 'vivid-computer-verify-unconfigured',
    ...executorEnv,
    VIVID_PHOTON_PROJECT_ID: 'verify-unconfigured',
    VIVID_PHOTON_PROJECT_SECRET: 'unconfigured-disposable-verification',
    VIVID_PUSH_VAPID_PUBLIC: curve.getPublicKey().toString('base64url'),
    VIVID_PUSH_VAPID_PRIVATE: curve.getPrivateKey().toString('base64url'),
    VIVID_PUSH_SUBJECT: 'mailto:verify@example.test',
    VIVID_DECISIONS: 'off',
    VIVID_DISCORD_PEOPLE: state.run + '@example.test',
    GOOGLE_CLIENT_ID: 'rehearsal',
    GOOGLE_CLIENT_SECRET: 'unused-google-rehearsal-authority',
    GOOGLE_REDIRECT_URI: state.web + '/api/auth/callback/google',
    PUBLIC_URL: state.web,
  }
  serverChild = await own(
    'server',
    [process.execPath, '--import', require.resolve('tsx'), root + '/apps/server/src/main.ts'],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    },
  )
  await serverReady(serverChild)
  await startCells(
    state,
    { run, own, save, cleanEnv },
    {
      ...provider,
      VIVID_RUNTIME_TOKEN: token,
      VIVID_SERVER_URL: state.server,
      VIVID_MODEL: state.model,
    },
  )
  const runtimeHealth = await fetch(env.VIVID_RUNTIME_URL + '/health')
  const runtimeValue = decodeText(RuntimeHealth, await runtimeHealth.text())
  await json(state.evidence + '/runtime-health.json', runtimeValue)
  if (!runtimeHealth.ok || runtimeValue.service !== 'vivid-cells' || runtimeValue.status !== 'ok')
    throw new Error('Native Worker health refused')
  await run([process.execPath, skill + '/scripts/dev.mjs', 'build', state.scratch], {
    cwd: root + '/apps/web',
    env: { ...cleanEnv, VIVID_SERVER_URL: state.server },
    heavy: true,
    log: state.evidence + '/web-build.json',
  })
  const web = await own(
    'web',
    [process.execPath, skill + '/scripts/dev.mjs', 'web', state.scratch, String(state.ports.web)],
    {
      cwd: root + '/apps/web',
      // Vite receives only proxy authority; runtime/auth secrets belong to the backend processes.
      env: { ...cleanEnv, VIVID_SERVER_URL: state.server },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  await signal(web, web, 'message', (value) => value._tag === 'Ready')
  const webHealth = await fetch(state.web + '/health')
  if (!(await webHealth.json()).ok) throw new Error('Proxy health refused')
  await signedIn()
  const probe = state.evidence + '/cell-activation'
  await NodeFSP.mkdir(probe)
  const thread = crypto.randomUUID()
  await rpc(state, 'CreateThread', { id: thread, title: 'Cell activation', projectId: null }, probe)
  await history(state, thread, probe)
  await json(probe + '/fleet.json', await cellSnapshot(state))
  state.cellProbe = thread
  state.ready = true
  state.launchSeconds = (Date.now() - Date.parse(state.started)) / 1000
  await save()
  await json(state.evidence + '/launch.json', {
    ready: true,
    launchSeconds: state.launchSeconds,
    web: state.web,
    server: state.server,
    run: state.run,
    head: state.head,
    dirty: state.dirty,
    diffHash: state.diffHash,
    tree: state.tree,
    model: state.model,
    modelKind: state.modelKind,
    host: state.hostname,
  })
  if (process.connected) process.send({ ready: true, run: state.run })
}
/** Publish the supervisor generation itself so Doctor and cleanup can distinguish PID reuse. */
async function ownReceipt() {
  state.processes.supervisor = await identity(process.pid)
  await save()
}

/** Cleanup remains usable after a failed launch and removes scratch only after owned resources close. */
function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = clean().catch((error) => {
    cleanupPromise = undefined
    throw error
  })
  return cleanupPromise
}
/** Coalesce concurrent teardown callers so none can claim cleanup before its owned resources exit. */
async function clean() {
  cleaning = true
  await NodeFSP.rm(state.scratch + '/provider.json', { force: true })
  const failures = []
  const { desktopCleanup } = await import('./desktopcleanup.mjs')
  try {
    await desktopCleanup(state)
  } catch (error) {
    failures.push('desktop cleanup: ' + error.message)
  }
  for (const captured of Object.values(state.commands ?? {})) {
    if (!runningCommands.has(captured.pid)) await stopCaptured(captured, true)
  }
  for (const { child, owned } of runningCommands.values()) {
    const closed = NodeEvents.once(child, 'close')
    await terminate(owned, 'SIGTERM', true)
    await closed
  }
  for (const role of [
    'browser-tunnel',
    'web',
    'runtime',
    'runtime-peer',
    'bucket',
    'server',
    'catalog',
    'executor-events',
  ]) {
    const child = children.get(role)
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    try {
      const closed = NodeEvents.once(child, 'close')
      // SSH's configured ProxyCommand inherits this detached group and its output pipes.
      // Signal the captured group while its original leader is alive, before waiting on EOF.
      await terminate(state.processes[role], 'SIGTERM', true)
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, 'SIGKILL')
      }, 8000)
      await closed
      clearTimeout(timer)
    } catch (error) {
      failures.push(error.message)
    }
  }
  const containers = (await run(['docker', 'ps', '-a', '--format', '{{.Names}}'])).split('\n')
  for (const container of [
    state.container,
    state.helixContainer,
    state.executorContainer,
    state.executorExporter,
  ].filter(Boolean)) {
    if (containers.includes(container)) {
      try {
        const label = await run([
          'docker',
          'inspect',
          '--format',
          '{{index .Config.Labels "vivid.verify"}}',
          container,
        ])
        if (label !== state.run) throw new Error('Container ownership mismatch')
        await run(['docker', 'rm', '--force', '--volumes', container], {
          heavy: true,
          log: state.evidence + '/container-cleanup.json',
        })
      } catch (error) {
        failures.push(error.message)
      }
    }
  }
  await phoneCleanup(state)
  await remoteCleanup(state, run)
  const browserReceipt = await NodeFSP.readFile(
    state.scratch + '/browser-cleanup.json',
    'utf8',
  ).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (browserReceipt) {
    const owned = JSON.parse(browserReceipt)
    const expected = 'v-' + state.run.slice(-8)
    if (
      owned.namespace !== expected ||
      !owned.directories.every(
        (directory) =>
          NodePath.basename(directory) === expected &&
          NodePath.basename(NodePath.dirname(directory)) === 'namespaces',
      )
    )
      throw new Error('Browser namespace ownership mismatch')
    for (const directory of owned.directories)
      await NodeFSP.rm(directory, { recursive: true, force: true })
    await json(state.evidence + '/browser-cleanup.json', owned)
  }
  if (failures.length === 0) await NodeFSP.rm(state.scratch, { recursive: true, force: true })
  state.ready = false
  state.cleaned = failures.length === 0
  await save()
  await json(state.evidence + '/cleanup.json', {
    failures,
    container: state.container,
    removedScratch: failures.length === 0,
    retainedEvidence: state.evidence,
  })
  if (failures.length) {
    cleaning = false
    throw new Error(failures.join('\n'))
  }
}

/** Unix control socket is 0600, not a product/test HTTP endpoint. It controls only captured fixtures. */
async function dispatch(input) {
  if (input.action === 'capture') {
    if (cleaning || !state.ready) throw new Error('Verification is not ready for workers')
    if (!(await alive(input.process))) return { captured: false, alreadyGone: true }
    // A fast browser CLI may exit between liveness and cwd reads. Recheck its generation before
    // accepting the receipt; disappearance needs no cleanup and PID reuse grants no authority.
    const cwd = await NodeFSP.readlink('/proc/' + input.process.pid + '/cwd').catch((error) => {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null
      throw error
    })
    if (!(await alive(input.process))) return { captured: false, alreadyGone: true }
    if (cwd !== root) throw new Error('Worker cwd is not this worktree')
    state.commands[input.process.pid] = input.process
    await save()
    return { captured: true }
  }
  if (input.action === 'cell') {
    if (cleaning || !state.ready) throw new Error('Verification is not ready for cell controls')
    return cellControl(state, { run, own, save, cleanEnv, children }, input)
  }
  if (input.action === 'cleanup') {
    await cleanup()
    return { cleaned: true }
  }
  throw new Error('Unknown control action')
}
control = NodeNet.createServer((socket) => {
  let text = ''
  socket.on('data', async (bytes) => {
    text += bytes
    if (!text.includes('\n')) return
    try {
      const result = await dispatch(JSON.parse(text.trim()))
      socket.end(JSON.stringify({ ok: true, result }) + '\n')
      if (cleaning) {
        control.close()
        process.exitCode = 0
      }
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n')
    }
  })
})
// The same file stays inside owned scratch; the fd address avoids Unix's path limit for longer
// worktree names. Keep the directory fd until listener close.
const socketDirectory = await NodeFSP.open(state.scratch, 'r')
control.once('close', () => socketDirectory.close())
control.listen('/proc/self/fd/' + socketDirectory.fd + '/c.sock')
await NodeEvents.once(control, 'listening')
await NodeFSP.chmod(state.scratch + '/c.sock', 0o600)
process.on('SIGTERM', () => {
  cleanup().finally(() => {
    control.close()
    process.exit()
  })
})
try {
  await launch()
} catch (error) {
  await json(state.evidence + '/launch-failure.json', { error: error.stack })
  if (state.helixCreated)
    await run(['docker', 'logs', state.helixContainer], {
      log: state.evidence + '/helix.log.json',
    }).catch(() => {})
  if (process.connected) process.send({ ready: false, error: error.message })
  await cleanup()
  control.close()
  process.exitCode = 1
}
