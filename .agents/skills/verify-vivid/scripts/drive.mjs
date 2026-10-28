import { approve, deny } from './approval.mjs'
import { question as realQuestion } from './question.mjs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { admit, chat, conversation, history, rpc, settled, json } from './wire.mjs'
import { command } from './process.mjs'
import { createRequire } from 'node:module'
import { assertTable } from './table.mjs'
import { devices } from './devices.mjs'
import { reading } from './reading.mjs'
import { settingsProof } from './settingsproof.mjs'
import { watch } from './watch.mjs'
import { memory } from './memory.mjs'
import { feed } from './feed.mjs'
import { offer } from './offer.mjs'
import { discordProof, discordBlocked } from './discord.mjs'
const web = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { pictureAddress } = await import(web.resolve('@vivid/state'))

export const features = [
  'first',
  'reload',
  'tool',
  'replies',
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
  'memory',
  'discord',
]
export const png =
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
/** Capture the Thread identity before the first Person message. */
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
/** A long ordinary reply supplies real streamed words to interrupt, without holding a tool.
 * Pi's abort commits the partial and settles its submission; cancelling our observer does not
 * stop work (Pi Durable 1.2/1.4 spec sections 2.2 and 5.4). An early answer fails this recipe. */
export async function stop(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'Stop requires a real model')
  const phrase =
    'Write a detailed 10000-word guide to planning a community garden, covering site selection, soil, irrigation, planting, maintenance and harvest. Write the guide directly in this reply as plain paragraphs. Do not create a document or ask questions.'
  if (browser) {
    await browser.capture('before')
    await browser.run(['find', 'label', 'Message Vivid', 'fill', phrase])
    await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  } else await admit(state, id, phrase, directory)
  for await (const active of conversation(state, id, { directory, name: 'active-stream' })) {
    NodeAssert.equal(active.settlements.length, 0, 'Run ended before Stop could be exercised')
    if (
      !active.working ||
      !active.messages.some(
        (message) =>
          message.purpose === 'assistant' &&
          message.parts.some(
            (part) => part.type === 'text' && part.state === 'streaming' && part.text.trim(),
          ),
      )
    )
      continue
    const detail = await rpc(state, 'GetThread', { id }, directory, 'active-thread')
    NodeAssert.equal(detail.runs.length, 1)
    const run = detail.runs[0]
    NodeAssert.equal(run.state._tag, 'Working', 'Captured Run is already terminal')
    NodeAssert.ok(run.submissionId, 'Active Run has no runtime submission')
    const partial = words({
      messages: active.messages.filter(
        (message) => message.purpose === 'assistant' && message.submissionId === run.submissionId,
      ),
    })
    NodeAssert.ok(partial.trim(), 'Streaming reply does not belong to the captured Run')
    await json(directory + '/active.json', { run, page: active, partial })
    if (browser) await browser.run(['find', 'role', 'button', 'click', '--name', 'Stop', '--exact'])
    else await rpc(state, 'StopThread', { id }, directory)
    const ended = await settled(state, id, 1, 'Stopped', directory)
    NodeAssert.equal(ended.runs[0].id, run.id, 'Stop settled a different Run')
    const page = await history(state, id, directory)
    NodeAssert.equal(page.working, false, 'Conversation is still working after Stop')
    NodeAssert.equal(page.queued, 0)
    NodeAssert.deepEqual(page.settlements, [{ submissionId: run.submissionId, outcome: 'aborted' }])
    NodeAssert.ok(
      page.messages.every((message) => message.parts.every((part) => part.state !== 'streaming')),
      'A reply part is still streaming after Stop',
    )
    NodeAssert.ok(
      words({
        messages: page.messages.filter((message) => message.purpose === 'assistant'),
      }).startsWith(partial),
      'Stop lost the streamed partial reply',
    )
    const reopened = await history(state, id, directory, 'reloaded-history')
    NodeAssert.equal(reopened.working, false, 'Reload restarted the conversation')
    NodeAssert.equal(reopened.queued, 0)
    NodeAssert.deepEqual(reopened.settlements, page.settlements)
    // Timing metadata is written after Pi settles; message identity and content are durable now.
    NodeAssert.deepEqual(
      reopened.messages.map((message) => ({ id: message.id, parts: message.parts })),
      page.messages.map((message) => ({ id: message.id, parts: message.parts })),
    )
    const reloaded = await rpc(state, 'GetThread', { id }, directory, 'reloaded-thread')
    NodeAssert.deepEqual(reloaded.runs, ended.runs, 'Reload changed or restarted the stopped Run')
    await rows(state, id, directory)
    return page
  }
  throw new Error('No active streamed reply to stop')
}
/** All three current question shapes are answered together through the Person RPC. */
async function question(state, id, directory) {
  if (state.modelKind === 'real') return realQuestion(state, id, directory)
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
      : 'Write me a document called Verification plan that says: # Verification plan\nResearch, writing and review.',
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
      : 'Add the sentence Ready for review to the end of the Verification plan document.',
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
      : 'Open the Verification plan document and tell me which version it is on now.',
    directory,
    'read',
  )
  const { page, detail } = await completed(state, id, directory, 3)
  const read = page.messages
    .filter(
      (message) =>
        message.role === 'assistant' && message.submissionId === detail.runs[2].submissionId,
    )
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
  NodeAssert.match(read.output.body, /Ready for review/)
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
  NodeAssert.match(v2.body, /Ready for review/)
}
/** Send a picture through the public contract and compare exact reloaded private bytes. */
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
  const url = new URL(pictureAddress(id, part.url), state.web)
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
  stop,
  tool,
  replies: offer,
  question,
  approve,
  deny,
  picture,
  document,
  devices,
  feed,
  memory,
  watch,
  reading,
  settings: settingsProof,
  discord: discordProof,
}
const blocked = {
  code: 'Needs a disposable Person Computer. No disposable Computer authority is configured.',
  library:
    'HTTP ingestion and browser Library recipes have not been implemented; the full product worker is mounted.',
  ...discordBlocked(),
}
/** Every feature gets an independent Thread and retained verdict; failure never skips the rest. */
export async function drive(state, feature) {
  const chosen = feature === 'all' ? features : [feature]
  if (chosen.some((name) => !features.includes(name))) throw new Error('Unknown feature ' + feature)
  const unavailable =
    state.modelKind === 'real'
      ? blocked
      : {
          ...blocked,
          approve: 'Approval requires a real model.',
          deny: 'Denial requires a real model.',
          stop: 'Stop requires a real model; rehearsal cannot prove interruption.',
          memory: 'Memory requires a real model; rehearsal cannot prove the memory tools.',
        }
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
    console.log(await rpc(state, 'StopThread', { id }, directory, 'abort'))
  else throw new Error('Unknown helper ' + action)
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await drive(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')), process.argv[3])
