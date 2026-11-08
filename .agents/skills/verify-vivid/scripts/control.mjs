import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeOS from 'node:os'
import { createRequire } from 'node:module'
import { boot } from './process.mjs'
import { recoverPrevious, recover, dependenciesCleanup } from './recovery.mjs'
import { doctor } from './doctor.mjs'
import { control } from './socket.mjs'
import { host, provider, selection, boatKey } from './settings.mjs'
import * as NodeChildProcess from 'node:child_process'
import {
  root,
  skill,
  freePorts,
  identity,
  command,
  signal,
  json,
  cache,
  dependencyLink,
  checkout,
  capacity,
  lock,
} from './process.mjs'
const [action = 'help', ...args] = process.argv.slice(2)
const loader = createRequire(root + '/apps/server/package.json').resolve('tsx')

/** The CLI always selects a run it created, never any ordinary application instance. */
async function selected() {
  const run =
    args.find((arg) => arg.startsWith('pi-')) ??
    (await NodeFSP.readFile(cache + '/current', 'utf8').catch(() => '')).trim()
  if (!run || !/^pi-[a-z0-9-]+$/.test(run))
    throw new Error('No verification run; execute verify launch')
  return JSON.parse(await NodeFSP.readFile(cache + '/' + run + '/state.json', 'utf8'))
}

/** Recover only abandoned recorded resources, then capture unique ownership before spawning. A live run is a conflict. */
async function launch() {
  const hostReceipt = await host()
  await NodeFSP.mkdir(cache, { recursive: true })
  await recoverPrevious(cache)
  await capacity()
  const modelConfig = await provider()
  const boat = await boatKey()
  const snapshot = await checkout()
  const head = await command(['git', 'rev-parse', 'HEAD'])
  const branch = await command(['git', 'branch', '--show-current'])
  const run =
    'pi-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomUUID().slice(0, 8)
  const evidence = cache + '/' + run
  const scratch = evidence + '/instance'
  const ports = await freePorts([
    'database',
    'server',
    'web',
    'runtime',
    'runtimePeer',
    'runtimeOperator',
    'runtimePeerOperator',
    'bucket',
    'executor',
    'catalog',
  ])
  await NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 })
  const state = {
    run,
    evidence,
    scratch,
    ports,
    processes: {},
    container: 'vivid-verify-' + run,
    started: new Date().toISOString(),
    head,
    branch,
    ...hostReceipt,
    ...snapshot,
    model: modelConfig.model,
    modelKind: modelConfig.model.startsWith('rehearsal/') ? 'rehearsal' : 'real',
    keySource: modelConfig.source,
    // With a Boat key the server creates the synthetic Person's own Computer on first need;
    // cleanup deletes exactly the machines the disposable database bound (computers.mjs).
    computer: boat === null ? 'unconfigured' : 'disposable',
    hostname: NodeOS.hostname(),
    boot,
    executorExporter: 'vivid-verify-exporter-' + run,
    ready: false,
    cleaned: false,
  }
  await json(evidence + '/state.json', state)
  await NodeFSP.writeFile(cache + '/current', run + '\n')
  const dependencies = dependencyLink
  const existing = await NodeFSP.lstat(dependencies).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (
    existing &&
    (!existing.isSymbolicLink() ||
      (await NodeFSP.readlink(dependencies)) !== root + '/packages/agent/runtime/node_modules')
  )
    throw new Error('Verification dependency link is not ours')
  if (!existing) await NodeFSP.symlink(root + '/packages/agent/runtime/node_modules', dependencies)
  const log = await NodeFSP.open(evidence + '/supervisor.log', 'a', 0o600)
  let child
  // A failed spawn, identity capture or readiness step must not retain the provider handoff.
  try {
    const handoff =
      boat === null ? modelConfig.env : { ...modelConfig.env, VIVID_BOAT_API_KEY: boat }
    await NodeFSP.writeFile(scratch + '/provider.json', JSON.stringify(handoff), {
      mode: 0o600,
    })
    const env = {
      PATH: process.env.PATH,
      HOME: scratch,
      COREPACK_HOME:
        process.env.COREPACK_HOME ?? NodePath.join(NodeOS.homedir(), '.cache/node/corepack'),
      COREPACK_ENABLE_NETWORK: '0',
    }
    // Only the path crosses; the supervisor reads the bot token into the server env.
    if (process.env.VIVID_VERIFY_DISCORD_TOKEN_FILE)
      env.VIVID_VERIFY_DISCORD_TOKEN_FILE = NodePath.resolve(
        process.env.VIVID_VERIFY_DISCORD_TOKEN_FILE,
      )
    child = NodeChildProcess.spawn(
      process.execPath,
      ['--import', loader, skill + '/scripts/supervisor.mjs', evidence + '/state.json'],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', log.fd, log.fd, 'ipc'],
        env: { ...env, VIVID_VERIFY_WORLD: process.env.VIVID_VERIFY_WORLD },
      },
    )
    state.processes.supervisor = await identity(child.pid)
    await json(evidence + '/state.json', state)
    // The shared heavy queue is part of launch elapsed time, not evidence of server readiness.
    const receipt = await signal(
      child,
      child,
      'message',
      (value) => Object.hasOwn(value, 'ready'),
      2_700_000,
    )
    if (!receipt.ready) throw new Error(receipt.error + '; evidence ' + evidence)
    console.log(
      JSON.stringify(
        JSON.parse(await NodeFSP.readFile(evidence + '/launch.json', 'utf8')),
        null,
        2,
      ),
    )
  } finally {
    await NodeFSP.rm(scratch + '/provider.json', { force: true })
    if (child) {
      if (child.connected) child.disconnect()
      child.unref()
    }
    await log.close()
  }
}

try {
  if (action === 'launch') await launch()
  else if (action === 'apk') {
    // The heavy lock lives in the checkout's cache, which only Launch created before.
    await NodeFSP.mkdir(NodePath.dirname(lock), { recursive: true })
    console.log(
      await command(
        [
          'flock',
          '-n',
          NodeOS.homedir() + '/.cache/vivid-android/lock',
          process.execPath,
          skill + '/scripts/compile.mjs',
        ],
        { heavy: true },
      ),
    )
  } else if (action === 'help')
    console.log(
      'verify launch | apk | doctor | behaviour <run> [--trials N] [--scenarios file] | cell state|list|start|stop|restart|move|owner-loss|evict [runtime|runtime-peer] | feature all|first|reload|tool|question|approve|deny|changed|outcome|stop|picture|code|document|watch|library|feed|projects|devices|discord|texting-discord|github|learning|name | browser <feature> | desktop | phone all|thread|name|send|tool|replies|question|approve|deny|stop|picture|document|memory|settings-memory|learning|feed|owed|move | android provision|stop|status <devbox> | android attach|status pc | cleanup | sign-in | create-thread | chat | history | stop\nOptional pi-… run ID selects retained run manifest. Evidence: .cache/verify/pi-…/',
    )
  else {
    const state = await selected()
    if (action === 'doctor') await doctor(state)
    else if (action === 'cell') {
      const [operation = 'state', role = 'runtime', scope] = args.filter(
        (arg) => !arg.startsWith('pi-'),
      )
      console.log(JSON.stringify(await control(state, { action: 'cell', operation, role, scope })))
    } else if (action === 'cleanup') {
      const result = await recover(state)
      console.log(JSON.stringify(result))
      await dependenciesCleanup()
      await NodeFSP.access(state.evidence + '/cleanup.json')
      console.log('Evidence retained: ' + state.evidence)
    } else {
      if ((await command(['git', 'rev-parse', 'HEAD'])) !== state.head)
        throw new Error('Checkout commit changed; clean this run and launch again')
      const snapshot = await checkout()
      if (snapshot.tree !== state.tree || snapshot.diffHash !== state.diffHash)
        throw new Error('Working tree changed; launch again')
      if (action === 'behaviour') {
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/behaviour.mjs',
              state.evidence + '/state.json',
              ...args.filter((arg) => !arg.startsWith('pi-')),
            ],
            {
              heavy: true,
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      } else if (action === 'feature')
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/drive.mjs',
              state.evidence + '/state.json',
              args.filter((arg) => !arg.startsWith('pi-'))[0] ?? 'all',
            ],
            {
              heavy: true,
              log: state.evidence + '/feature-command.json',
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      else if (action === 'phone')
        console.log(
          await command(
            [
              'flock',
              '-n',
              NodeOS.homedir() + '/.cache/vivid-android/lock',
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/phone.mjs',
              state.evidence + '/state.json',
              args.find((arg) => !arg.startsWith('pi-')) ?? 'thread',
            ],
            {
              heavy: true,
              log: state.evidence + '/phone-command.json',
              env: { ...process.env, ...selection(state) },
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      else if (action === 'desktop') {
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/desktop.mjs',
              state.evidence + '/state.json',
            ],
            {
              heavy: true,
              log: state.evidence + '/desktop-command.json',
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      } else if (action === 'browser')
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/browser.mjs',
              state.evidence + '/state.json',
              args.filter((arg) => !arg.startsWith('pi-'))[0] ?? 'all',
            ],
            {
              heavy: true,
              log: state.evidence + '/browser-command.json',
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      else {
        const { manual } = await import('./drive.mjs')
        await manual(
          state,
          action,
          args.filter((arg) => !arg.startsWith('pi-')),
        )
      }
    }
  }
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
}
