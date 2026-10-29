import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeCrypto from 'node:crypto'
import { LibraryUploadResponse } from '@vivid/contracts'
import { Account, decodeText } from './receipts.mjs'
import { chat, history, json, rpc, settled } from './wire.mjs'
import { observe } from './observation.mjs'

/** The answer exists only in the uploaded bytes, so a prompt echo cannot prove retrieval. */
export async function libraryFile(directory) {
  const marker = crypto.randomUUID().slice(0, 8)
  const project = 'Harbor' + marker
  const answer = 'Saffron Pavilion ' + crypto.randomUUID().slice(0, 8)
  const name = project + '.txt'
  const text = `${project} fieldwork handbook\nThe fieldwork meeting point for ${project} is ${answer}.\n`
  const file = directory + '/' + name
  const prompt = `What is the fieldwork meeting point for ${project} in my Library file ${name}? Search the Library and cite the source as [${name}] in your answer.`
  await NodeFSP.writeFile(file, text)
  const fixture = { name, file, text, project, answer, prompt }
  await json(directory + '/fixture.json', fixture)
  return fixture
}

/** WatchLibrary publishes the worker's durable outcome. A deadline fails; elapsed time never passes. */
export async function libraryReady(state, fixture, directory) {
  const observed = []
  try {
    const list = await observe(state, {
      tag: 'WatchLibrary',
      payload: { shelf: 'Mine' },
      accept(value) {
        observed.push(value)
        return value.documents.some(
          (item) => item.name === fixture.name && item.status !== 'processing',
        )
      },
    })
    const document = list.documents.find((item) => item.name === fixture.name)
    NodeAssert.ok(document, 'Ingestion publication lost the uploaded file')
    NodeAssert.equal(document.status, 'ready', 'Library ingestion failed: ' + document.error)
    NodeAssert.ok(document.chunkCount > 0, 'Ready file has no searchable passages')
    NodeAssert.ok(document.preview.includes(fixture.answer), 'Preview lost the uploaded fact')
    await json(directory + '/ready.json', document)
    return document
  } finally {
    await json(directory + '/ingestion.json', observed)
  }
}

/** Use the same multipart byte route as the file picker, without inserting metadata or chunks. */
async function upload(state, fixture, directory) {
  const account = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  const body = new FormData()
  body.set('file', new Blob([fixture.text], { type: 'text/plain' }), fixture.name)
  body.set('shelf', 'Mine')
  const response = await fetch(state.web + '/api/library', {
    method: 'POST',
    headers: { cookie: account.cookie, origin: state.web },
    body,
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  await json(directory + '/upload.json', { status: response.status, body: text })
  NodeAssert.equal(response.status, 201, 'New Library upload was not accepted')
  return decodeText(LibraryUploadResponse, text).document
}

/** Public reads prove original bytes and extracted search content independently of the model. */
export async function libraryContent(state, { fixture, document, directory }) {
  const account = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  const path = '/api/library/' + document.id + '/content'
  const response = await fetch(state.web + path, {
    headers: { cookie: account.cookie },
    signal: AbortSignal.timeout(300_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  await NodeFSP.writeFile(directory + '/original.txt', bytes)
  await json(directory + '/content.json', {
    path,
    status: response.status,
    mimeType: response.headers.get('content-type'),
    sha256: NodeCrypto.createHash('sha256').update(bytes).digest('hex'),
  })
  NodeAssert.equal(response.status, 200)
  NodeAssert.match(response.headers.get('content-type'), /^text\/plain\b/u)
  NodeAssert.deepEqual(bytes, Buffer.from(fixture.text))
  const found = await rpc(state, 'SearchLibrary', { query: fixture.project }, directory, 'search')
  NodeAssert.ok(
    found.results.some(
      (result) =>
        result.documentId === document.id &&
        result.filename === fixture.name &&
        result.text.includes(fixture.answer),
    ),
    'Extracted fact is absent from Library search',
  )
}

/** Inspect only this Run's real tool output and reply; the prompt never contains the answer. */
export async function libraryReply(state, id, fixture, directory) {
  const detail = await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  const parts = page.messages
    .filter(
      (message) =>
        message.role === 'assistant' && message.submissionId === detail.runs[0].submissionId,
    )
    .flatMap((message) => message.parts)
  const searches = parts.filter(
    (part) =>
      part.type === 'dynamic-tool' &&
      part.toolName === 'search_library' &&
      part.state === 'output-available',
  )
  NodeAssert.ok(
    searches.some((part) =>
      part.output.results.some(
        (result) =>
          result.filename === fixture.name &&
          result.text.includes(fixture.answer) &&
          result.citation === `[${fixture.name}]`,
      ),
    ),
    'Model did not retrieve the uploaded passage',
  )
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
  NodeAssert.ok(text.includes(fixture.answer), 'Reply lacks the fact from the uploaded file')
  NodeAssert.ok(text.includes(`[${fixture.name}]`), 'Reply lacks the source citation')
  await json(directory + '/citation.json', { text, searches })
  const reopened = await history(state, id, directory, 'reloaded-history')
  NodeAssert.deepEqual(
    reopened.messages.map((message) => ({ id: message.id, parts: message.parts })),
    page.messages.map((message) => ({ id: message.id, parts: message.parts })),
    'Reload lost the cited reply',
  )
  return text
}

/** Delete only this recipe's uploaded item and prove it left the Person's shelf. */
export async function removeLibraryFile(state, fixture, directory) {
  const before = await rpc(state, 'ListLibrary', { shelf: 'Mine' }, directory, 'cleanup-list')
  const document = before.documents.find((item) => item.name === fixture.name)
  if (!document) return
  await rpc(state, 'DeleteLibraryItem', { id: document.id }, directory)
  const list = await rpc(state, 'ListLibrary', { shelf: 'Mine' }, directory, 'after-delete')
  NodeAssert.ok(!list.documents.some((item) => item.id === document.id))
}

/** A Person uploads, the real worker indexes, and Vivid answers from that file in a Thread. */
export async function library(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Library requires a real model')
  const fixture = await libraryFile(directory)
  try {
    const document = await upload(state, fixture, directory)
    const ready = await libraryReady(state, fixture, directory)
    NodeAssert.equal(ready.id, document.id)
    await libraryContent(state, { fixture, document: ready, directory })
    await chat(state, id, fixture.prompt, directory)
    await libraryReply(state, id, fixture, directory)
    const reloaded = await rpc(
      state,
      'GetLibraryItem',
      { id: document.id },
      directory,
      'reloaded-item',
    )
    NodeAssert.deepEqual(reloaded.document, ready)
  } finally {
    await removeLibraryFile(state, fixture, directory)
  }
}
