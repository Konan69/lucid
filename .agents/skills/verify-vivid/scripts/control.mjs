import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeOS from 'node:os'
import { createRequire } from 'node:module'
import { boot } from './process.mjs'
import { recoverPrevious, recover, dependenciesCleanup } from './recovery.mjs'
import { doctor } from './doctor.mjs'
import { control } from './socket.mjs'
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
} from './process.mjs'
const [action = 'help', ...args] = process.argv.slice(2)
const loader = createRequire(root + '/apps/server/package.json').resolve('tsx')

/** The CLI always selects a run it created, never any ordinary application instance. */
async function selected() {
  const run =
    args.find((arg) => arg.startsWith('flue-')) ??
    (await NodeFSP.readFile(cache + '/current', 'utf8').catch(() => '')).trim()
  if (!run || !/^flue-[a-z0-9-]+$/.test(run))
    throw new Error('No verification run; execute verify launch')
  return JSON.parse(await NodeFSP.readFile(cache + '/' + run + '/state.json', 'utf8'))
}

/** Recover only abandoned recorded resources, then capture unique ownership before spawning. A live run is a conflict. */
async function launch() {
  await NodeFSP.mkdir(cache, { recursive: true })
  await recoverPrevious(cache)
  const { host, provider } = await import('./settings.mjs')
  const hostReceipt = await host()
  const modelConfig = await provider()
  const tree = await command(['git', 'status', '--porcelain=v1', '-uall'])
  const head = await command(['git', 'rev-parse', 'HEAD'])
  const branch = await command(['git', 'branch', '--show-current'])
  const run =
    'flue-' +
    new Date().toISOString().replace(/[^0-9]/g, '') +
    '-' +
    crypto.randomUUID().slice(0, 8)
  const evidence = cache + '/' + run
  const scratch = evidence + '/instance'
  const ports = await freePorts(['database', 'helix', 'server', 'web', 'runtime'])
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
    tree,
    dirty: tree.length > 0,
    model: modelConfig.model,
    modelKind: modelConfig.model.startsWith('rehearsal/') ? 'rehearsal' : 'real',
    keySource: modelConfig.source,
    hostname: NodeOS.hostname(),
    boot,
    helixContainer: 'vivid-verify-helix-' + run,
    ready: false,
    cleaned: false,
  }
  await json(evidence + '/state.json', state)
  await NodeFSP.writeFile(scratch + '/provider.json', JSON.stringify(modelConfig.env), {
    mode: 0o600,
  })
  await NodeFSP.writeFile(cache + '/current', run + '\n')
  const dependencies = dependencyLink
  const existing = await NodeFSP.lstat(dependencies).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (
    existing &&
    (!existing.isSymbolicLink() ||
      (await NodeFSP.readlink(dependencies)) !== root + '/apps/server/node_modules')
  )
    throw new Error('Verification dependency link is not ours')
  if (!existing) await NodeFSP.symlink(root + '/apps/server/node_modules', dependencies)
  const log = await NodeFSP.open(evidence + '/supervisor.log', 'a', 0o600)
  const child = NodeChildProcess.spawn(
    process.execPath,
    [skill + '/scripts/supervisor.mjs', evidence + '/state.json'],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        COREPACK_HOME:
          process.env.COREPACK_HOME ?? NodePath.join(NodeOS.homedir(), '.cache/node/corepack'),
        COREPACK_ENABLE_NETWORK: '0',
      },
    },
  )
  state.processes.supervisor = await identity(child.pid)
  await json(evidence + '/state.json', state)
  let receipt
  try {
    // The shared heavy queue is part of launch elapsed time, not evidence of server readiness.
    receipt = await signal(
      child,
      child,
      'message',
      (value) => Object.hasOwn(value, 'ready'),
      2_700_000,
    )
  } finally {
    if (child.connected) child.disconnect()
    child.unref()
  }
  if (!receipt.ready) throw new Error(receipt.error + '; evidence ' + evidence)
  console.log(
    JSON.stringify(JSON.parse(await NodeFSP.readFile(evidence + '/launch.json', 'utf8')), null, 2),
  )
}

try {
  if (action === 'launch') await launch()
  else if (action === 'help')
    console.log(
      'verify launch | doctor | feature all|first|reload|tool|question|approve|deny|stop|picture|code|document|watch|library|feed | browser | cleanup | sign-in | create-thread | chat | history | stop\nOptional flue-… run ID selects retained run manifest. Evidence: .cache/verify/flue-…/',
    )
  else {
    const state = await selected()
    if (action === 'doctor') await doctor(state)
    else if (action === 'cleanup') {
      const result = await recover(state)
      console.log(JSON.stringify(result))
      await dependenciesCleanup()
      await NodeFSP.access(state.evidence + '/cleanup.json')
      console.log('Evidence retained: ' + state.evidence)
    } else {
      if ((await command(['git', 'rev-parse', 'HEAD'])) !== state.head)
        throw new Error('Checkout commit changed; clean this run and launch again')
      const tree = await command(['git', 'status', '--porcelain=v1', '-uall'])
      if (tree !== state.tree) throw new Error('Working tree changed; launch again')
      if (action === 'feature')
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/drive.mjs',
              state.evidence + '/state.json',
              args.filter((arg) => !arg.startsWith('flue-'))[0] ?? 'all',
            ],
            {
              heavy: true,
              log: state.evidence + '/feature-command.json',
              record: (process) => control(state, { action: 'capture', process }),
            },
          ),
        )
      else if (action === 'browser')
        console.log(
          await command(
            [
              process.execPath,
              '--import',
              loader,
              skill + '/scripts/browser.mjs',
              state.evidence + '/state.json',
              args.filter((arg) => !arg.startsWith('flue-'))[0] ?? 'all',
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
          args.filter((arg) => !arg.startsWith('flue-')),
        )
      }
    }
  }
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
}
