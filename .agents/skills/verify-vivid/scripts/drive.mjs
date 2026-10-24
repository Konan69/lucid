import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { chat, history, rpc, request, settled, json } from './wire.mjs'
import { command } from './process.mjs'
import { assertTable } from './table.mjs'
import { devices } from './devices.mjs'
import { reading } from './reading.mjs'
import { settingsProof } from './settingsproof.mjs'
import { watch } from './watch.mjs'
import { notes } from './notes.mjs'
import { feed } from './feed.mjs'
export const features = [
  'first',
  'reload',
  'tool',
  'question',
  'approve',
  'deny',
  'stop',
  'picture',
  'code',
  'document',
  'watch',
  'library',
  'feed',
  'devices',
  'reading',
  'settings',
  'notes',
]
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const words = (page) =>
  page.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')

/** Port of verify-vivid-pi/scripts/drive.mjs:rows. Only generated UUIDs reach read-only SQL. */
async function rows(state, thread, directory) {
  NodeAssert.match(thread, /^[0-9a-f-]{36}$/)
  for (const table of [
    'vivid_conversations',
    'vivid_runs',
    'vivid_input_requests',
    'vivid_approvals',
  ]) {
    const field = table === 'vivid_conversations' ? 'id' : 'thread_id'
    const sql = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM ${table} WHERE ${field}='${thread}') t;`
    const output = await command([
      'docker',
      'exec',
      state.container,
      'psql',
      '-U',
      'verify',
      '-d',
      'verify',
      '-At',
      '-c',
      sql,
    ])
    await json(directory + '/' + table + '.json', JSON.parse(output))
  }
}
/** Main's default Thread is Flue. Capture its identity before the first Person message. */
async function thread(state, directory, title) {
  const id = crypto.randomUUID()
  await rpc(state, 'CreateThread', { id, title, projectId: null }, directory)
  await json(directory + '/context.json', {
    thread: id,
    person: state.person,
    web: state.web,
    head: state.head,
  })
  return id
}
/** Durable publication, public conversation and SQL provide independent observable evidence. */
async function completed(state, id, directory, count = 1) {
  const detail = await settled(state, id, count, 'Completed', directory)
  const page = await history(state, id, directory)
  await rows(state, id, directory)
  return { detail, page }
}
/** One new Thread gets one Person contribution and a real streamed reply from the selected model. */
async function first(state, id, directory) {
  const text = await chat(state, id, 'Hello Vivid', directory)
  NodeAssert.ok(text.trim().length > 0)
  if (state.modelKind === 'rehearsal') NodeAssert.match(text, /^Try one of these phrases:/)
  const { page } = await completed(state, id, directory)
  NodeAssert.deepEqual(
    page.messages.map((message) => message.role),
    ['user', 'assistant'],
  )
  const normalized = (value) => value.replace(/\s+/g, ' ').trim()
  NodeAssert.ok(
    normalized(
      words({ messages: page.messages.filter((message) => message.role === 'assistant') }),
    ).includes(normalized(text)),
  )
}
/** Inline OpenUI is part of the real reply; no obsolete show tool is expected. */
async function tool(state, id, directory) {
  await chat(
    state,
    id,
    state.modelKind === 'rehearsal'
      ? 'show a table'
      : 'Show a rich interactive table using an openui-lang Table, not Markdown. Columns Project, Hours, Owner. Rows Research | 4 | Ada, Writing | 3 | Ben, Review | 2 | Cai. Title Workload.',
    directory,
  )
  const { page } = await completed(state, id, directory)
  await assertTable(page)
}
/** Reconnect from durable history, independently of the original stream. */
async function reload(state, id, directory) {
  await chat(
    state,
    id,
    'Remember the verification marker amber-orchid. Acknowledge briefly.',
    directory,
    'seed',
  )
  const before = await completed(state, id, directory)
  const reopened = await history(state, id, directory, 'reopened-history')
  NodeAssert.deepEqual(reopened.messages, before.page.messages)
  await chat(
    state,
    id,
    'What verification marker did I ask you to remember? Reply with the marker only.',
    directory,
    'followup',
  )
  const { page } = await completed(state, id, directory, 2)
  NodeAssert.equal(page.messages.filter((message) => message.role === 'user').length, 2)
  const last = page.messages.filter((m) => m.role === 'assistant').at(-1)
  NodeAssert.match(words({ messages: [last] }), /amber-orchid/i)
}
/** All three current question shapes are answered together through the Person RPC. */
async function question(state, id, directory) {
  await chat(state, id, 'ask me', directory)
  const detail = await settled(state, id, 1, 'Completed', directory)
  NodeAssert.equal(detail.requests.length, 1)
  NodeAssert.equal(detail.requests[0].questions.length, 3)
  const answers = [
    { _tag: 'Chosen', labels: ['Research', 'Writing'] },
    { _tag: 'Chosen', labels: ['Brief'] },
    { _tag: 'Written', words: 'Evidence and next steps' },
  ]
  const response = await rpc(
    state,
    'AnswerInput',
    { id: detail.requests[0].id, answers },
    directory,
  )
  NodeAssert.equal(response.request.state._tag, 'Answered')
  NodeAssert.deepEqual(response.request.state.answers, answers)
  const after = await completed(state, id, directory, 2)
  NodeAssert.ok(after.detail.runs.some((run) => run.origin._tag === 'Decision'))
}
/** Vivid writes and revises through real tools; Person reads confirm immutable versions. */
async function document(state, id, directory) {
  await chat(
    state,
    id,
    state.modelKind === 'rehearsal'
      ? 'write a document'
      : 'Use write_document to create a document titled Verification plan with body # Verification plan\nResearch, writing and review. Only write this one document.',
    directory,
    'write',
  )
  await completed(state, id, directory)
  const created = await rpc(
    state,
    'ListArtifacts',
    { threadId: id },
    directory,
    'created-artifacts',
  )
  NodeAssert.equal(created.artifacts.length, 1)
  const artifact = created.artifacts[0]
  NodeAssert.equal(
    artifact.title,
    state.modelKind === 'rehearsal' ? 'Rehearsal plan' : 'Verification plan',
  )
  NodeAssert.equal(artifact.version, 1)
  await chat(
    state,
    id,
    state.modelKind === 'rehearsal'
      ? 'revise the document'
      : 'Use write_document with the same title Verification plan to revise the existing document. Send the whole body with the added sentence Ready for review. Do not change the title.',
    directory,
    'revise',
  )
  await completed(state, id, directory, 2)
  const revised = await rpc(
    state,
    'ListArtifacts',
    { threadId: id },
    directory,
    'revised-artifacts',
  )
  NodeAssert.equal(revised.artifacts[0].id, artifact.id)
  NodeAssert.equal(revised.artifacts[0].version, 2)
  await chat(
    state,
    id,
    state.modelKind === 'rehearsal'
      ? 'read the document'
      : 'Use read_document to read the existing Verification plan document at its latest version and tell me the version number.',
    directory,
    'read',
  )
  const { page, detail } = await completed(state, id, directory, 3)
  const read = page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === detail.runs[2].id)
    .flatMap((message) => message.parts)
    .find(
      (part) =>
        part.type === 'dynamic-tool' &&
        part.toolName === 'read_document' &&
        part.state === 'output-available',
    )
  NodeAssert.ok(read, 'Third Run did not execute read_document')
  NodeAssert.equal(read.output.ok, true)
  NodeAssert.equal(read.output.version, 2)
  NodeAssert.match(read.output.body, /Ready for review\./)
  const v1 = await rpc(
    state,
    'GetArtifact',
    { id: artifact.id, version: 1 },
    directory,
    'version-1',
  )
  const v2 = await rpc(
    state,
    'GetArtifact',
    { id: artifact.id, version: 2 },
    directory,
    'version-2',
  )
  NodeAssert.equal(v1.shown.number, 1)
  NodeAssert.equal(v2.shown.number, 2)
  NodeAssert.notEqual(v1.body, v2.body)
  NodeAssert.match(v2.body, /Ready for review\./)
}
/** Main's image attachment follows Flue's wire format. Compare exact reloaded private bytes. */
async function picture(state, id, directory) {
  await NodeFSP.writeFile(directory + '/sent.png', Buffer.from(png, 'base64'))
  await chat(state, id, 'Hello Vivid with a picture', directory, 'chat', [
    { type: 'image', data: png, mimeType: 'image/png', filename: 'pixel.png' },
  ])
  const { page } = await completed(state, id, directory)
  const part = page.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'file')
  NodeAssert.ok(part, 'No saved picture part')
  const url = new URL(part.url, state.web)
  NodeAssert.equal(url.origin, state.web)
  NodeAssert.ok(url.pathname.startsWith(`/api/vivid/${id}/attachments/`))
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const response = await fetch(url, { headers: { cookie: account.cookie } })
  const bytes = Buffer.from(await response.arrayBuffer())
  await NodeFSP.writeFile(directory + '/reloaded.png', bytes)
  await json(directory + '/picture-response.json', {
    status: response.status,
    mediaType: response.headers.get('content-type'),
    bytes: bytes.length,
    url: url.pathname,
  })
  NodeAssert.equal(response.status, 200)
  NodeAssert.equal(response.headers.get('content-type'), 'image/png')
  NodeAssert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  NodeAssert.deepEqual(bytes, Buffer.from(png, 'base64'))
}
const recipes = {
  first,
  reload,
  tool,
  question,
  picture,
  document,
  devices,
  feed,
  notes,
  watch,
  reading,
  settings: settingsProof,
}
const blocked = {
  code: 'Needs a disposable Person Computer. No disposable Computer authority is configured.',
  stop: 'No reproducible active Run recipe is implemented. A real model alone does not prove Stop during an active Run; no held tool or fabricated response is installed.',
  approve:
    'Needs an actual pending proposal from a connected disposable Integration. Synthetic Gate proposals do not prove the Person journey.',
  deny: 'Needs an actual pending proposal from a connected disposable Integration.',
  library:
    'HTTP ingestion and browser Library recipes have not been implemented; the full product worker is mounted.',
}
const realBlocked = {
  ...blocked,
  question: 'Question HTTP recipe is rehearsal-only; real-model question recipe is blocked',
}
/** Every feature gets an independent Thread and retained verdict; failure never skips the rest. */
export async function drive(state, feature) {
  const chosen = feature === 'all' ? features : [feature]
  if (chosen.some((name) => !features.includes(name))) throw new Error('Unknown feature ' + feature)
  const unavailable =
    state.modelKind === 'real'
      ? realBlocked
      : { ...blocked, notes: 'Notes requires a real model; rehearsal cannot prove Notes tools.' }
  let failed = false
  for (const name of chosen) {
    const directory = state.evidence + '/' + name
    await NodeFSP.mkdir(directory, { recursive: true })
    const started = Date.now()
    let id
    let verdict
    try {
      if (unavailable[name])
        verdict = { feature: name, verdict: 'blocked', reason: unavailable[name] }
      else {
        id = await thread(state, directory, 'Verify ' + name)
        await recipes[name](state, id, directory)
        verdict = {
          feature: name,
          verdict: state.modelKind === 'rehearsal' ? 'plumbing-only' : 'proved',
        }
      }
    } catch (error) {
      verdict = { feature: name, verdict: 'failed', error: error.stack }
      if (id)
        await rows(state, id, directory).catch((error) =>
          json(directory + '/sql-failure.json', { error: error.message }),
        )
    }
    verdict = {
      ...verdict,
      head: state.head,
      dirty: state.dirty,
      diffHash: state.diffHash,
      tree: state.tree,
      model: state.model,
      modelKind: state.modelKind,
      host: state.hostname,
      command: '.agents/skills/verify-vivid/verify feature ' + name + ' ' + state.run,
      evidence: directory,
      seconds: (Date.now() - started) / 1000,
    }
    await json(directory + '/verdict.json', verdict)
    console.log(JSON.stringify(verdict))
    if (verdict.verdict !== 'proved') failed = true
  }
  if (failed) process.exitCode = 1
}

/** Public helpers retain the reference command names and saved manual Thread selection. */
export async function manual(state, action, args) {
  const directory = state.evidence + '/manual'
  await NodeFSP.mkdir(directory, { recursive: true })
  const selection = state.scratch + '/selection.json'
  if (action === 'create-thread') {
    const id = await thread(state, directory, 'Verification manual')
    await json(selection, { thread: id })
    console.log(id)
    return
  }
  if (action === 'sign-in') {
    const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
    const response = await fetch(state.web + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: state.web, 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    })
    NodeAssert.equal(response.status, 200)
    account.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    await json(state.scratch + '/account.json', account)
    console.log('Signed in to disposable account')
    return
  }
  const { thread: id } = JSON.parse(await NodeFSP.readFile(selection, 'utf8'))
  if (action === 'chat') {
    const before = await rpc(state, 'GetThread', { id }, directory)
    console.log(await chat(state, id, args.join(' ') || 'Hello Vivid', directory))
    await settled(state, id, before.runs.length + 1, 'Completed', directory)
  } else if (action === 'history')
    console.log(JSON.stringify(await history(state, id, directory), null, 2))
  else if (action === 'stop')
    console.log(
      await request(state, `/api/vivid/${id}/abort`, { method: 'POST', directory, name: 'abort' }),
    )
  else throw new Error('Unknown helper ' + action)
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await drive(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')), process.argv[3])
