import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const [product, runId] = process.argv.slice(2)
const state = JSON.parse(await fs.readFile(`${product}/.cache/verify/${runId}/state.json`, 'utf8'))
const skill = `${product}/.agents/skills/verify-vivid/scripts`
const { command, json, identity, alive } = await import(`${skill}/process.mjs`)
const { control } = await import(`${skill}/socket.mjs`)
const { rpc, history } = await import(`${skill}/wire.mjs`)
const { stopCaptured } = await import(`${skill}/recovery.mjs`)
const require = createRequire(`${product}/apps/server/package.json`)
const { Pool } = require('pg')
const database = new Pool({
  connectionString: `postgres://verify:verify@127.0.0.1:${state.ports.database}/verify`,
})
const directory = `${state.evidence}/migration/browser`
await fs.mkdir(directory, { recursive: true })
const summary = JSON.parse(await fs.readFile(`${state.evidence}/migration/summary.json`, 'utf8'))
const pictured = summary.histories.find(
  (thread) => thread.threadId === summary.attachmentSources[0].retained_thread,
)
assert.ok(pictured)
const chosen = [pictured]
for (const thread of summary.histories) {
  if (chosen.length === 3) break
  if (
    thread.personId === pictured.personId &&
    thread.threadId !== pictured.threadId &&
    thread.messages > 5
  )
    chosen.push(thread)
}
assert.equal(chosen.length, 3)
const account = JSON.parse(await fs.readFile(`${state.scratch}/account.json`, 'utf8'))
const sessions = await database.query(
  'UPDATE session SET "userId"=$1 WHERE "userId"=$2 RETURNING id',
  [pictured.personId, account.person],
)
assert.ok(sessions.rowCount > 0)
const receipt = {
  executable: process.env.VIVID_VERIFY_BROWSER || 'agent-browser',
  namespace: 'v-' + state.run.slice(-8),
  session: 'v',
  scratch: state.scratch,
  socketDirectory: '/tmp/vivid-verify-' + state.run.slice(-8),
  chrome: '/opt/google/chrome/chrome',
  processes: [],
}
const auth = `${state.scratch}/migration-auth.json`
await fs.writeFile(
  auth,
  JSON.stringify({
    cookies: account.cookie.split('; ').map((part) => ({
      name: part.slice(0, part.indexOf('=')),
      value: part.slice(part.indexOf('=') + 1),
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    })),
    origins: [],
  }),
  { mode: 0o600 },
)
await fs.mkdir(receipt.socketDirectory, { recursive: true, mode: 0o700 })
await json(`${state.scratch}/browser.json`, receipt)
let sequence = 0
const run = (args) =>
  command(
    [
      receipt.executable,
      '--namespace',
      receipt.namespace,
      '--session',
      receipt.session,
      '--executable-path',
      receipt.chrome,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: state.scratch,
        AGENT_BROWSER_SOCKET_DIR: receipt.socketDirectory,
      },
      log: `${directory}/${String(++sequence).padStart(2, '0')}-${args[0]}.json`,
      record: (process) => control(state, { action: 'capture', process }),
    },
  )

/** Capture only PID receipts in this run's private browser namespace, then their descendants. */
async function capture(pid) {
  if (receipt.processes.some((process) => process.pid === pid)) return
  receipt.processes.push(await identity(pid))
  for (const tid of await fs.readdir(`/proc/${pid}/task`)) {
    const children = await fs
      .readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
    for (const child of children.trim().split(/\s+/u).filter(Boolean))
      await capture(Number(child)).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
  }
}
/** PID files are scoped to the owned browser namespace; no process-name lookup grants authority. */
async function receipts(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = `${directory}/${entry.name}`
    if (entry.isDirectory()) await receipts(file)
    else if (entry.name.endsWith('.pid'))
      await capture(Number((await fs.readFile(file, 'utf8')).trim()))
  }
}
const verdict = {
  head: state.head,
  dirty: state.dirty,
  model: state.model,
  run: state.run,
  threads: [],
  scope:
    'Three copied Threads rendered and reloaded; copy has tool-result images only, no user pictures',
}
try {
  const list = await rpc(state, 'ListThreads', undefined, directory)
  assert.ok(list.threads.some((thread) => thread.id === pictured.threadId))
  await run(['--state', auth, 'open', state.web + '/t/' + pictured.threadId])
  await receipts(receipt.socketDirectory)
  await receipts(`${state.scratch}/.agent-browser/namespaces/${receipt.namespace}`)
  assert.ok(receipt.processes.length > 0)
  await json(`${state.scratch}/browser.json`, receipt)
  for (const thread of chosen) {
    const detail = await rpc(
      state,
      'GetThread',
      { id: thread.threadId },
      directory,
      `detail-${thread.threadId}`,
    )
    const before = await history(state, thread.threadId, directory, `before-${thread.threadId}`)
    const text = before.messages
      .filter((message) => message.purpose === 'user')
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
    const expected = text
      .map((part) => part.match(/[A-Za-z][A-Za-z ,]{24,80}/u))
      .find((match) => match !== null)
    assert.ok(expected)
    await run(['open', state.web + '/t/' + thread.threadId])
    for (const phase of ['opened', 'reloaded']) {
      if (phase === 'reloaded') await run(['reload'])
      await run(['wait', '[aria-label="Message Vivid"]'])
      await run([
        'wait',
        '--fn',
        `document.body.textContent.replace(/\\s+/g,' ').includes(${JSON.stringify(expected[0].trim().replace(/\s+/gu, ' '))})`,
      ])
      await fs.writeFile(
        `${directory}/${thread.threadId}-${phase}.aria.txt`,
        await run(['snapshot']),
      )
      await run(['screenshot', `${directory}/${thread.threadId}-${phase}.png`, '--full'])
    }
    const after = await history(state, thread.threadId, directory, `after-${thread.threadId}`)
    assert.deepEqual(after, before)
    verdict.threads.push({
      threadId: thread.threadId,
      messages: before.messages.length,
      runs: detail.runs.length,
    })
  }
  verdict.status = 'passed'
} catch (error) {
  verdict.status = 'failed'
  verdict.error = error.message
  process.exitCode = 1
} finally {
  await run(['close'])
  for (const process of [...receipt.processes].reverse()) await stopCaptured(process)
  for (const process of receipt.processes) assert.equal(await alive(process), false)
  await json(`${directory}/processes.json`, receipt.processes)
  await fs.rm(receipt.socketDirectory, { recursive: true, force: true })
  await fs.rm(`${state.scratch}/browser.json`, { force: true })
  await fs.rm(auth, { force: true })
  await database.query(
    'UPDATE session SET "userId"=$1 WHERE "userId"=$2 AND id = ANY($3::text[])',
    [account.person, pictured.personId, sessions.rows.map((row) => row.id)],
  )
  await database.end()
  await json(`${directory}/verdict.json`, verdict)
  summary.browser = verdict
  summary.status = verdict.status
  await json(`${state.evidence}/migration/summary.json`, summary)
}
console.log(JSON.stringify(verdict))
