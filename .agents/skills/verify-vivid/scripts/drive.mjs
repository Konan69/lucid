import { approve, changed, deny } from './approval.mjs'
import { outcome } from './outcome.mjs'
import { question as realQuestion } from './question.mjs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import * as NodeCrypto from 'node:crypto'
import { ArtifactInspectionId } from '@vivid/contracts'
import { Schema } from 'effect'
import { Account, decodeText } from './receipts.mjs'
import { admit, chat, conversation, history, rpc, settled, json } from './wire.mjs'
import { command } from './process.mjs'
import { createRequire } from 'node:module'
import { assertTable } from './table.mjs'
import { capabilities, computer } from './capabilities.mjs'
import { devices } from './devices.mjs'
import { reading } from './reading.mjs'
import { helpers, helperstop } from './helpers.mjs'
import { settingsProof } from './settingsproof.mjs'
import { nameProof } from './nameproof.mjs'
import { watch } from './watch.mjs'
import { integrations } from './integrations.mjs'
import { memory } from './memory.mjs'
import { learningFact } from './phonememory.mjs'
import { procedure } from './procedure.mjs'
import { feed } from './feed.mjs'
import { owed } from './owed.mjs'
import { todos } from './todos.mjs'
import { projects } from './projects.mjs'
import { offer } from './offer.mjs'
import { discordProof, discordBlocked } from './discord.mjs'
import { githubProof, githubBlocked } from './github.mjs'
import { library } from './library.mjs'
import { capture, computerFile } from './computers.mjs'
import { pushProof } from './push.mjs'
const web = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { pictureAddress } = await import(web.resolve('@vivid/state'))

import { textingDiscordProof, textingDiscordBlocked } from './textingdiscord.mjs'
export const features = [
  'capabilities',
  'computer',
  'first',
  'reload',
  'tool',
  'replies',
  'question',
  'handoff',
  'approve',
  'deny',
  'changed',
  'outcome',
  'stop',
  'picture',
  'code',
  'document',
  'watch',
  'integrations',
  'library',
  'feed',
  'owed',
  'todos',
  'projects',
  'devices',
  'reading',
  'settings',
  'name',
  'memory',
  'learning',
  'procedure',
  'discord',
  'github',
  'push',
  'texting-discord',
  'helpers',
  'helperstop',
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
  const revision = await completed(state, id, directory, 2)
  const revised = await rpc(
    state,
    'ListArtifacts',
    { threadId: id },
    directory,
    'revised-artifacts',
  )
  NodeAssert.equal(revised.artifacts[0].id, artifact.id)
  // Vivid may revise more than once in one Run (29 October 2026: it added a comma, then restored
  // the Person's wording, ending on version 3). Each new version must be one of that Run's own
  // write_document receipts, so no version appears from anywhere else.
  const latest = revised.artifacts[0].version
  const writes = revision.page.messages
    .filter(
      (message) =>
        message.role === 'assistant' &&
        message.submissionId === revision.detail.runs[1].submissionId,
    )
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === 'dynamic-tool' &&
        part.toolName === 'write_document' &&
        part.state === 'output-available' &&
        part.output.kind === 'artifact',
    )
  NodeAssert.ok(latest >= 2, 'The revision made no new version')
  NodeAssert.deepEqual(
    Array.from(new Set(writes.map((part) => part.output.artifact.version))).filter(
      (version) => version > 1,
    ),
    Array.from({ length: latest - 1 }, (_, index) => index + 2),
    'Each new version must be a write_document receipt of the revision Run',
  )
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
  NodeAssert.equal(read.output.version, latest)
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
    { id: artifact.id, version: latest },
    directory,
    'version-' + latest,
  )
  NodeAssert.equal(v1.shown.number, 1)
  NodeAssert.equal(v2.shown.number, latest)
  NodeAssert.equal(v1.content._tag, 'Document')
  NodeAssert.equal(v2.content._tag, 'Document')
  NodeAssert.notEqual(v1.content.body, v2.content.body)
  NodeAssert.match(v2.content.body, /Ready for review/)
  if (state.modelKind === 'real') await documentFile(state, id, directory)
}
const InspectionReceipt = Schema.Struct({ inspection: ArtifactInspectionId })

/** The model receives the render image before delivering a PDF with its retained Word source. */
async function documentFile(state, id, directory) {
  await chat(
    state,
    id,
    'Make a short one-page Word document titled File verification with the paragraph Exact bytes, retained source, reviewed render. Use python3 and the Computer document tools. Keep it as verification.docx, export verification.pdf, inspect_file on the PDF with its separate DOCX source, look at the returned image, then publish_file titled File verification with your visual review. Do not use write_document for this file.',
    directory,
    'file-write',
  )
  const { page, detail } = await completed(state, id, directory, 4)
  const steps = page.messages
    .filter(
      (message) =>
        message.role === 'assistant' && message.submissionId === detail.runs[3].submissionId,
    )
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.state === 'output-available')
  const published = steps.find(
    (part) => part.toolName === 'publish_file' && part.output.kind === 'artifact',
  )
  NodeAssert.ok(published, 'No file publication receipt; a proof-owned Computer is required')
  const inspected = steps.find(
    (part) =>
      part.toolName === 'inspect_file' &&
      Array.isArray(part.output) &&
      part.output.some((block) => block.type === 'image' && block.mimeType === 'image/png'),
  )
  NodeAssert.ok(inspected, 'inspect_file did not return native image content to the model')
  NodeAssert.ok(
    steps.indexOf(inspected) < steps.indexOf(published),
    'Publication preceded the inspection image',
  )
  const inspectionText = inspected.output.find((block) => block.type === 'text')
  NodeAssert.ok(inspectionText, 'Inspection receipt text is missing')
  const inspection = decodeText(InspectionReceipt, inspectionText.text)
  NodeAssert.equal(published.input.inspection, inspection.inspection)
  const reference = published.output.artifact
  const artifact = await rpc(
    state,
    'GetArtifact',
    { id: reference.id, version: reference.version },
    directory,
    'file-artifact',
  )
  NodeAssert.equal(artifact.content._tag, 'File')
  NodeAssert.equal(artifact.content.output.mimeType, 'application/pdf')
  NodeAssert.equal(artifact.content.source._tag, 'Separate')
  NodeAssert.match(artifact.content.source.file.name, /\.docx$/u)
  NodeAssert.equal(artifact.content.preview._tag, 'Separate')
  NodeAssert.equal(artifact.content.review.toolCallId, inspected.toolCallId)
  NodeAssert.equal(artifact.content.review.outputDigest, artifact.content.output.sha256)
  const account = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  const downloads = []
  for (const [role, file] of [
    ['output', artifact.content.output],
    ['source', artifact.content.source.file],
    ['preview', artifact.content.preview.file],
  ]) {
    const response = await fetch(
      `${state.web}/api/artifacts/${reference.id}/versions/${reference.version}/files/${role}`,
      { headers: { cookie: account.cookie } },
    )
    NodeAssert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = NodeCrypto.createHash('sha256').update(bytes).digest('hex')
    NodeAssert.equal(sha256, file.sha256)
    NodeAssert.equal(bytes.length, file.byteLength)
    await NodeFSP.writeFile(`${directory}/file-${role}`, bytes)
    downloads.push({
      role,
      sha256,
      byteLength: bytes.length,
      mimeType: response.headers.get('content-type'),
    })
  }
  await json(directory + '/file-proof.json', {
    artifact: reference,
    inspectionToolCall: inspected.toolCallId,
    nativeImage: true,
    downloads,
  })
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
/** The same learning assertion as Android, driven through public HTTP on a devbox without a phone. */
async function learning(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Learning needs a real model')
  const marker = 'Teacup-' + crypto.randomUUID().slice(0, 8)
  await chat(
    state,
    id,
    `For project ${marker}, I always choose green tea at the planning sessions. Just acknowledge briefly.`,
    directory,
  )
  const detail = await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory, 'exchange')
  await learningFact(state, directory, marker, { detail, page })
  const next = await thread(state, directory, 'Learning recall ' + marker)
  await chat(
    state,
    next,
    `What drink do I always choose at the planning sessions for project ${marker}?`,
    directory,
  )
  await settled(state, next, 1, 'Completed', directory)
  const recalled = await history(state, next, directory, 'recalled')
  NodeAssert.match(
    words({ messages: recalled.messages.filter((message) => message.role === 'assistant') }),
    /green tea/iu,
  )
}

/** The words that ask Vivid for one program that writes a file this run owns. */
export function program(state) {
  const name = `vivid-verify-${state.run.slice(-8)}-${crypto.randomUUID().slice(0, 8)}.txt`
  const marker = crypto.randomUUID()
  return {
    name,
    marker,
    phrase: `Do this with one run_code program and nothing else. In the program, use node:fs/promises to write a file named ${name} in the current directory holding exactly the text ${marker}, then return that text. Afterwards tell me what the program wrote.`,
  }
}

/** One finished run_code receipt in the Thread, then the file read back through Boat, not Vivid.
 * Shared by the HTTP and browser recipes once the Person's message has settled. */
export async function ranProgram(state, page, asked, directory) {
  const programs = page.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.toolName === 'run_code')
  NodeAssert.equal(programs.length, 1, 'Expected exactly one run_code program')
  NodeAssert.equal(programs[0].state, 'output-available', 'The program did not finish')
  NodeAssert.equal(programs[0].output.ok, true, 'The program did not run to its end')
  await capture(state)
  const written = await computerFile(state, asked.name)
  await json(directory + '/computer-file.json', { ...asked, ...written })
  NodeAssert.equal(written.text.trim(), asked.marker, 'The Computer holds other text')
}

/** Vivid runs a program on the synthetic Person's own new Computer. */
async function code(state, id, directory) {
  const asked = program(state)
  await chat(state, id, asked.phrase, directory)
  const { page } = await completed(state, id, directory)
  await ranProgram(state, page, asked, directory)
}
const recipes = {
  capabilities,
  computer,
  first,
  code,
  reload,
  stop,
  tool,
  replies: offer,
  question,
  approve,
  deny,
  changed,
  outcome,
  picture,
  document,
  devices,
  feed,
  memory,
  learning,
  procedure,
  owed,
  todos,
  projects,
  watch,
  integrations,
  reading,
  settings: settingsProof,
  name: nameProof,
  discord: discordProof,
  github: githubProof,
  library,
  push: pushProof,
  'texting-discord': textingDiscordProof,
  helpers,
  helperstop,
}
const blocked = {
  handoff: 'No proof-owned Computer: a handoff is prepared and filled on a disposable Person Computer.',
  ...discordBlocked(),
  ...githubBlocked(),
  ...textingDiscordBlocked(),
}
/** Every feature gets an independent Thread and retained verdict; failure never skips the rest. */
export async function drive(state, feature) {
  const chosen = feature === 'all' ? features : [feature]
  if (chosen.some((name) => !features.includes(name))) throw new Error('Unknown feature ' + feature)
  const computer =
    state.computer === 'disposable'
      ? {}
      : { code: 'Needs a disposable Person Computer. Launch had no VIVID_BOAT_API_KEY.' }
  const unavailable =
    state.modelKind === 'real'
      ? { ...blocked, ...computer }
      : {
          ...blocked,
          name: 'Name requires a real model; rehearsal cannot answer what the Person is called.',
          ...computer,
          code: 'A program requires a real model; rehearsal cannot write it.',
          approve: 'Approval requires a real model.',
          deny: 'Denial requires a real model.',
          changed: 'A stale ask requires a real model.',
          outcome: 'Action receipts require a real model to make the write.',
          stop: 'Stop requires a real model; rehearsal cannot prove interruption.',
          memory: 'Memory requires a real model; rehearsal cannot prove the memory tools.',
          procedure: 'Teaching requires a real model; rehearsal cannot prove it.',
          owed: 'Tracking requires a real model; rehearsal cannot prove it.',
          todos: 'The list requires a real model; rehearsal cannot prove it.',
          library: 'Library requires a real model; rehearsal cannot prove retrieval and citation.',
          projects: 'Project state requires a real model; rehearsal cannot prove it.',
          helpers: 'Helpers require a real model; rehearsal cannot start one.',
          helperstop: 'Helpers require a real model; rehearsal cannot start one.',
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
    // Any feature may have woken the Computer; its id is recorded before the next one starts.
    await capture(state)
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
