import * as NodeFSP from 'node:fs/promises'
import { root, boot, alive, command, json, cache, dependencyLink } from './process.mjs'
import { control } from './socket.mjs'
import { remoteCleanup } from './remote.mjs'

/** The retained manifest grants cleanup authority only for canonical paths and the exact run name.
 * A forged/corrupt record cannot direct deletion at another directory, container or the app DB. */
export async function owned(state) {
  if (!/^flue-\d{17}-[a-f0-9]{8}$/.test(state.run))
    throw new Error('Invalid verification run identity')
  const evidence = cache + '/' + state.run
  if (
    state.evidence !== evidence ||
    state.scratch !== evidence + '/instance' ||
    state.container !== 'vivid-verify-' + state.run
  )
    throw new Error('Verification ownership mismatch')
  if (
    state.helixContainer !== undefined &&
    state.helixContainer !== 'vivid-verify-helix-' + state.run
  )
    throw new Error('Helix ownership mismatch')
  if ((await NodeFSP.realpath(evidence)) !== evidence)
    throw new Error('Evidence directory is a symlink')
  const scratch = await NodeFSP.lstat(state.scratch).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (scratch && (!scratch.isDirectory() || scratch.isSymbolicLink()))
    throw new Error('Scratch is not our directory')
  for (const port of Object.values(state.ports))
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 55433)
      throw new Error('Invalid verification port')
}

/** Old manifests lack boot ids. A launch predating the kernel boot cannot own any present PID,
 * even if Linux reused its number and start ticks. Newly captured identities carry boot directly. */
export async function sameBoot(state) {
  if (state.boot !== undefined) return state.boot === boot
  const stat = await NodeFSP.readFile('/proc/stat', 'utf8')
  const match = /^btime (\d+)$/m.exec(stat)
  if (!match) throw new Error('Kernel boot time missing')
  return Date.parse(state.started) >= Number(match[1]) * 1000
}
export async function supervisorAlive(state) {
  return (await sameBoot(state)) && (await alive(state.processes.supervisor))
}

/** Remove only directories reported by this run's private agent-browser namespace. */
export async function browserDirectories(state) {
  const text = await NodeFSP.readFile(state.scratch + '/browser-cleanup.json', 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (text === null) return
  const receipt = JSON.parse(text)
  const expected = 'v-' + state.run.slice(-8)
  const suffix = '/namespaces/' + expected
  if (
    receipt.namespace !== expected ||
    !receipt.directories.every(
      (directory) => directory.endsWith(suffix) && !directory.split('/').includes('..'),
    )
  )
    throw new Error('Browser namespace ownership mismatch')
  for (const directory of receipt.directories)
    await NodeFSP.rm(directory, { recursive: true, force: true })
  await NodeFSP.writeFile(
    state.evidence + '/browser-cleanup.json',
    JSON.stringify(receipt, null, 2),
  )
}

/** pidfd binds a captured generation before signalling, then exit is a kernel signal. A surviving
 * owned process gets a finite shutdown deadline and escalation, never a sleep or a PID-name lookup. */
export async function stopCaptured(process, group = false) {
  if (!(await alive(process))) return { process, alreadyGone: true }
  const script = `import os, signal, select, sys
pid = int(sys.argv[1])
try:
    fd = os.pidfd_open(pid)
    stat = open(f"/proc/{pid}/stat").read()
    if stat[stat.rfind(")") + 2:].split()[19] != sys.argv[3]:
        sys.exit(0)
    if sys.argv[2] == "group":
        os.killpg(pid, signal.SIGTERM)
    signal.pidfd_send_signal(fd, signal.SIGTERM)
    exited = select.select([fd], [], [], 8)[0]
    if not exited:
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        assert select.select([fd], [], [], 8)[0], "owned process did not exit"
except (ProcessLookupError, FileNotFoundError):
    pass
`
  return {
    process,
    output: await command([
      'python3',
      '-c',
      script,
      String(process.pid),
      group ? 'group' : 'single',
      process.start,
    ]),
  }
}

/** Abandoned-run cleanup depends only on its recorded authority, not a lost control socket.
 * Docker absence is success; presence requires the exact label before removal. Evidence survives. */
export async function recover(state) {
  await owned(state)
  if (await supervisorAlive(state)) {
    try {
      return await control(state, { action: 'cleanup' })
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
      await stopCaptured(state.processes.supervisor)
    }
  }
  const receipts = []
  if (await sameBoot(state)) {
    for (const captured of Object.values(state.commands ?? {}))
      receipts.push(await stopCaptured(captured, true))
    for (const role of ['browser-tunnel', 'web', 'runtime', 'server', 'database-events']) {
      const process = state.processes[role]
      if (process)
        receipts.push({ role, ...(await stopCaptured(process, role !== 'database-events')) })
    }
  }
  const names = (await command(['docker', 'ps', '-a', '--format', '{{.Names}}'])).split('\n')
  let container = 'absent'
  for (const name of [state.container, state.helixContainer].filter(Boolean)) {
    if (names.includes(name)) {
      const label = await command([
        'docker',
        'inspect',
        '--format',
        '{{index .Config.Labels "vivid.verify"}}',
        name,
      ])
      if (label !== state.run) throw new Error('Container ownership mismatch; left untouched')
      await command(['docker', 'rm', '--force', '--volumes', name], {
        heavy: true,
        log: state.evidence + '/container-cleanup.json',
      })
      container = 'removed'
    }
  }
  await remoteCleanup(state, (argv, options) =>
    command(argv, {
      ...options,
      record: async (process) => {
        if (!state.commands) state.commands = {}
        state.commands[process.pid] = process
        await json(state.evidence + '/state.json', state)
      },
    }),
  )
  await browserDirectories(state)
  await NodeFSP.rm(state.scratch, { recursive: true, force: true })
  state.ready = false
  state.cleaned = true
  await json(state.evidence + '/state.json', state)
  const result = {
    cleaned: true,
    recovered: true,
    boot,
    container,
    processes: receipts,
    failures: [],
    removedScratch: true,
    retainedEvidence: state.evidence,
  }
  await NodeFSP.writeFile(state.evidence + '/cleanup.json', JSON.stringify(result, null, 2))
  return result
}

/** The only shared link removed is our exact dependency target; never follow or replace another. */
export async function dependenciesCleanup() {
  // The link is shared by this checkout's runs. Cleaning retained evidence cannot revoke
  // module resolution while another captured supervisor still owns an active instance.
  for (const name of await NodeFSP.readdir(cache)) {
    if (!name.startsWith('flue-')) continue
    const state = JSON.parse(await NodeFSP.readFile(cache + '/' + name + '/state.json', 'utf8'))
    await owned(state)
    if (!state.cleaned && (await supervisorAlive(state))) return
  }
  const link = dependencyLink
  if (
    (await NodeFSP.readlink(link).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'EINVAL') return null
      throw error
    })) ===
    root + '/apps/server/node_modules'
  )
    await NodeFSP.unlink(link)
}

/** Launch clears abandoned recorded runs, including stopped labelled containers; a live instance
 * is a real conflict and remains untouched. Invalid/unrecorded directories fail visibly. */
export async function recoverPrevious(cache) {
  const names = (await command(['docker', 'ps', '-a', '--format', '{{.Names}}'])).split('\n')
  for (const name of await NodeFSP.readdir(cache)) {
    if (!name.startsWith('flue-')) continue
    const state = JSON.parse(await NodeFSP.readFile(cache + '/' + name + '/state.json', 'utf8'))
    await owned(state)
    const scratch = await NodeFSP.lstat(state.scratch).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (state.cleaned && !scratch && !names.includes(state.container)) continue
    if (await supervisorAlive(state))
      throw new Error('Live verification run ' + name + '; execute verify cleanup ' + name)
    const result = await recover(state)
    await NodeFSP.writeFile(
      state.evidence + '/launch-recovery.json',
      JSON.stringify(result, null, 2),
    )
  }
}
