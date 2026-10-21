import * as NodeTest from 'node:test'
import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeOS from 'node:os'
const testCache = await NodeFSP.mkdtemp(NodeOS.tmpdir() + '/vivid-recovery-')
process.env.VIVID_VERIFY_CACHE = testCache
process.env.VIVID_VERIFY_DEPENDENCIES = testCache + '/dependencies'
NodeTest.after(() => NodeFSP.rm(testCache, { recursive: true, force: true }))
const { root, skill, identity, command, alive, boot } = await import('./process.mjs')

/** Exercise the actual CLI after a captured process exits; no lifecycle seam is mocked. */
async function cli(args) {
  const child = NodeChildProcess.spawn(skill + '/verify', args, {
    cwd: root,
    env: { ...process.env, VIVID_VERIFY_DEVBOX: 'invalid-test-host' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (bytes) => (output += bytes))
  child.stderr.on('data', (bytes) => (output += bytes))
  const [code] = await NodeEvents.once(child, 'close')
  return { code, output }
}

/** Capture a real child at spawn. Dead fixtures intentionally retain evidence for launch recovery;
 * live fixtures register shutdown before any filesystem write so failed setup leaves no child. */
async function fixture(context, live = false) {
  const run =
    'flue-' +
    new Date().toISOString().replace(/[^0-9]/g, '') +
    '-' +
    crypto.randomUUID().slice(0, 8)
  const evidence = testCache + '/' + run
  const scratch = evidence + '/instance'
  const child = NodeChildProcess.spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const closed = NodeEvents.once(child, 'close')
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end()
      await closed
    }
  })
  const captured = await identity(child.pid)
  if (!live) {
    child.stdin.end()
    await closed
  }
  const state = {
    run,
    evidence,
    scratch,
    container: 'vivid-verify-' + run,
    ports: {},
    processes: { supervisor: captured },
    head: await command(['git', 'rev-parse', 'HEAD']),
    boot,
    started: new Date().toISOString(),
    ready: false,
    cleaned: false,
    containerCreated: true,
  }
  await NodeFSP.mkdir(scratch, { recursive: true })
  await NodeFSP.writeFile(evidence + '/state.json', JSON.stringify(state, null, 2))
  return state
}

NodeTest.test(
  'Doctor reports an incomplete dead run as unworthy without throwing',
  async (context) => {
    const state = await fixture(context)
    const result = await cli(['doctor', state.run])
    await NodeFSP.writeFile(
      state.evidence + '/doctor-regression.json',
      JSON.stringify(result, null, 2),
    )
    NodeAssert.equal(result.code, 1)
    NodeAssert.equal(JSON.parse(result.output).worthy, false)
  },
)

NodeTest.test(
  'Cleanup succeeds after its captured supervisor exits and no container exists',
  async (context) => {
    const state = await fixture(context)
    const result = await cli(['cleanup', state.run])
    await NodeFSP.writeFile(
      state.evidence + '/cleanup-regression.json',
      JSON.stringify(result, null, 2),
    )
    NodeAssert.equal(result.code, 0, result.output)
    NodeAssert.equal(
      JSON.parse(await NodeFSP.readFile(state.evidence + '/state.json', 'utf8')).cleaned,
      true,
    )
    await NodeAssert.rejects(NodeFSP.access(state.scratch), { code: 'ENOENT' })
    await NodeFSP.access(state.evidence + '/cleanup-regression.json')
  },
)

NodeTest.test('a quick real subprocess exit does not fail its command capture', async () => {
  for (let index = 0; index < 12; index++) NodeAssert.equal(await command(['/usr/bin/true']), '')
})

NodeTest.test(
  'a previous boot cannot grant authority over a presently live captured PID',
  async (context) => {
    const state = await fixture(context, true)
    const captured = state.processes.supervisor
    NodeAssert.equal(await alive(captured), true)
    NodeAssert.equal(await alive({ ...captured, boot: crypto.randomUUID() }), false)
    NodeAssert.equal(await alive(captured), true)
  },
)

/** A supervisor crash must not strand a separately captured product child. */
NodeTest.test(
  'crash cleanup stops the recorded child and preserves evidence on repeated cleanup',
  async (context) => {
    const state = await fixture(context)
    const child = NodeChildProcess.spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    const closed = NodeEvents.once(child, 'close')
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
        await closed
      }
    })
    state.processes.server = await identity(child.pid)
    await NodeFSP.writeFile(state.evidence + '/state.json', JSON.stringify(state, null, 2))
    NodeAssert.equal(await alive(state.processes.server), true)
    const first = await cli(['cleanup', state.run])
    NodeAssert.equal(first.code, 0, first.output)
    await closed
    NodeAssert.equal(await alive(state.processes.server), false)
    const second = await cli(['cleanup', state.run])
    NodeAssert.equal(second.code, 0, second.output)
    await NodeFSP.access(state.evidence + '/state.json')
    await NodeFSP.access(state.evidence + '/cleanup.json')
  },
)

/** Launch must reject a live owner rather than clean its container or reuse its instance. */
NodeTest.test(
  'launch refuses a live recorded run before acquiring product resources',
  async (context) => {
    const state = await fixture(context, true)
    const result = await cli(['launch'])
    NodeAssert.equal(result.code, 1, result.output)
    NodeAssert.ok(result.output.includes('Live verification run ' + state.run), result.output)
    NodeAssert.equal(await alive(state.processes.supervisor), true)
    await NodeFSP.access(state.scratch)
  },
)

/** A lost control socket must not turn an owned orphan into an uncleanable live-run conflict. */
NodeTest.test(
  'cleanup handles a surviving captured supervisor whose control socket is gone',
  async (context) => {
    const state = await fixture(context, true)
    const result = await cli(['cleanup', state.run])
    NodeAssert.equal(result.code, 0, result.output)
    NodeAssert.equal(await alive(state.processes.supervisor), false)
    await NodeFSP.access(state.evidence + '/cleanup.json')
  },
)

/** An old run's cleanup cannot take away module resolution from the current recorded owner. */
NodeTest.test(
  'cleaning an old run preserves dependencies of another live recorded run',
  async (context) => {
    const live = await fixture(context, true)
    const dead = await fixture(context)
    const link = testCache + '/dependencies'
    const target = root + '/apps/server/node_modules'
    context.after(async () => {
      if ((await NodeFSP.readlink(link).catch(() => null)) === target) await NodeFSP.unlink(link)
    })
    await NodeFSP.symlink(target, link)
    const result = await cli(['cleanup', dead.run])
    NodeAssert.equal(result.code, 0, result.output)
    NodeAssert.equal(await alive(live.processes.supervisor), true)
    await NodeFSP.access(link + '/effect')
  },
)
