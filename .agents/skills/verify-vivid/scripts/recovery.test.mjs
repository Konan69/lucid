import * as NodeTest from 'node:test'
import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeOS from 'node:os'
import * as NodeHttp from 'node:http'
const testCache = await NodeFSP.mkdtemp(NodeOS.tmpdir() + '/vivid-recovery-')
process.env.VIVID_VERIFY_CACHE = testCache
process.env.VIVID_VERIFY_DEPENDENCIES = testCache + '/dependencies'
NodeTest.after(() => NodeFSP.rm(testCache, { recursive: true, force: true }))
const { root, skill, identity, command, alive, boot } = await import('./process.mjs')

/** Exercise the actual CLI after a captured process exits; no lifecycle seam is mocked. */
async function cli(args, env = {}) {
  const child = NodeChildProcess.spawn(skill + '/verify', args, {
    cwd: root,
    env: { ...process.env, VIVID_VERIFY_DEVBOX: 'invalid-test-host', ...env },
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
    'pi-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomUUID().slice(0, 8)
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
  'crash cleanup stops both runtimes and the native bucket and preserves evidence',
  async (context) => {
    const state = await fixture(context)
    const closed = []
    for (const role of ['runtime', 'runtime-peer', 'bucket']) {
      const child = NodeChildProcess.spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      })
      const exit = NodeEvents.once(child, 'close')
      closed.push(exit)
      context.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.end()
          await exit
        }
      })
      state.processes[role] = await identity(child.pid)
      NodeAssert.equal(await alive(state.processes[role]), true)
    }
    await NodeFSP.writeFile(state.evidence + '/state.json', JSON.stringify(state, null, 2))
    const first = await cli(['cleanup', state.run])
    NodeAssert.equal(first.code, 0, first.output)
    NodeAssert.equal(await alive(state.processes.runtime), false)
    NodeAssert.equal(await alive(state.processes['runtime-peer']), false)
    NodeAssert.equal(await alive(state.processes.bucket), false)
    await Promise.all(closed)
    const second = await cli(['cleanup', state.run])
    NodeAssert.equal(second.code, 0, second.output)
    await NodeFSP.access(state.evidence + '/state.json')
    await NodeFSP.access(state.evidence + '/cleanup.json')
  },
)

/** Host validation must precede recovery, so an invalid host cannot mutate even a live run. */
NodeTest.test(
  'launch refuses an invalid host before changing a live recorded run',
  async (context) => {
    const state = await fixture(context, true)
    const result = await cli(['launch'])
    NodeAssert.equal(result.code, 1, result.output)
    NodeAssert.ok(result.output.includes('Selected devbox does not match'), result.output)
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
    const target = root + '/packages/agent/runtime/node_modules'
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

/** A run's Computer is a Boat machine with no label: cleanup deletes exactly the id its database
 * bound, records Boat's answers, and a second cleanup finds it gone and sends nothing. */
NodeTest.test('cleanup deletes the captured Boat machine once and converges', async (context) => {
  const state = await fixture(context)
  state.computer = 'disposable'
  await NodeFSP.writeFile(state.evidence + '/state.json', JSON.stringify(state, null, 2))
  const id = 'bx_verifytest'
  await NodeFSP.writeFile(
    state.evidence + '/machines.json',
    JSON.stringify([{ intent: crypto.randomUUID(), id }]),
  )
  const requests = []
  let present = true
  const boat = NodeHttp.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== 'Bearer verify-test-key') response.statusCode = 401
    else if (request.url !== '/sandboxes/' + id || !present) response.statusCode = 404
    else if (request.method === 'GET')
      return response.end(JSON.stringify({ sandbox: { createdAt: new Date().toISOString() } }))
    else if (request.method === 'DELETE' && request.headers['x-ascii-confirm-delete'] === id) {
      present = false
      response.statusCode = 202
      return response.end(JSON.stringify({ operation: { id: 'bdop_test', status: 'pending' } }))
    } else response.statusCode = 409
    response.end('{}')
  })
  context.after(() => boat.close())
  await NodeEvents.once(boat.listen(0, '127.0.0.1'), 'listening')
  const env = {
    VIVID_VERIFY_BOAT_URL: 'http://127.0.0.1:' + boat.address().port,
    VIVID_BOAT_API_KEY: 'verify-test-key',
  }
  for (const pass of [1, 2]) {
    const result = await cli(['cleanup', state.run], env)
    NodeAssert.equal(result.code, 0, result.output)
    NodeAssert.ok(!result.output.includes('verify-test-key'), 'Cleanup printed the Boat key')
    NodeAssert.equal(requests.filter((request) => request.method === 'DELETE').length, 1, pass)
  }
  const { Schema } = await import('effect')
  const { decodeText } = await import('./receipts.mjs')
  const Receipt = Schema.Struct({ outcome: Schema.String, get: Schema.Number })
  const passes = decodeText(
    Schema.Array(Schema.Struct({ receipts: Schema.Array(Receipt) })),
    await NodeFSP.readFile(state.evidence + '/computer-cleanup.json', 'utf8'),
  )
  NodeAssert.deepEqual(
    passes.map((entry) => entry.receipts.map((receipt) => [receipt.outcome, receipt.get])),
    [[['deleted', 404]], [['absent', 404]]],
  )
})
