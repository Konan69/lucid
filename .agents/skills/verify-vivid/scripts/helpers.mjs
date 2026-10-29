import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { RpcSerialization } from 'effect/rpc'
import { ThreadDetail } from '@vivid/contracts'
import { command } from './process.mjs'
import { chat, decode, history, json, rpc } from './wire.mjs'

/**
 * Public pages a Researcher helper can read without a Computer: two RFCs about reserved names,
 * short, stable and different enough that a comparison must quote both.
 */
export const PAGES = [
  'https://www.rfc-editor.org/rfc/rfc2606.txt',
  'https://www.rfc-editor.org/rfc/rfc6761.txt',
]
/** Longer reading for the stop journey, so one helper is still at work when it is stopped. */
const LONG = [
  'https://www.rfc-editor.org/rfc/rfc9110.txt',
  'https://www.rfc-editor.org/rfc/rfc9111.txt',
  'https://www.rfc-editor.org/rfc/rfc9112.txt',
  'https://www.rfc-editor.org/rfc/rfc9113.txt',
]

export const helperLimits = [
  'Executor and ComputerUse helpers need a proof-owned Computer: blocked: no proof-owned Computer.',
  'ReadOnly reads files on the Computer: blocked: no proof-owned Computer.',
  'Restart and cell owner moves across spawn, report and stop are not driven here.',
  'Phone and desktop native rows need their own device runs.',
]

const ACTIVE = new Set(['Reserved', 'Working', 'Stopping'])
const ended = (run) => !ACTIVE.has(run.state._tag)

/**
 * Follow the public WatchThread publication until `until` holds. Each published ThreadDetail is
 * retained, so the evidence shows the helpers working side by side, not only how they ended.
 */
export async function watchUntil(state, thread, until, directory, name) {
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(new Error(name + ' deadline')), 600_000)
  const seen = []
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'WatchThread',
          payload: { id: thread },
          headers: [],
        }) + '\n',
      signal: abort.signal,
    })
    let buffer = ''
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const packet = JSON.parse(line)
        if (packet._tag === 'Exit') throw new Error(name + ' ended: ' + line)
        if (packet._tag !== 'Chunk') continue
        for (const value of packet.values) {
          const detail = decode(RpcSerialization.ndjson.codecFor(ThreadDetail), value)
          seen.push({
            runs: detail.runs,
            children: detail.children,
            attention: detail.thread.attention,
          })
          if (until(detail)) {
            await json(directory + '/' + name + '.json', seen)
            return detail
          }
        }
      }
    }
    throw new Error(name + ' stream closed')
  } finally {
    clearTimeout(deadline)
    abort.abort()
    await json(directory + '/' + name + '-seen.json', seen)
  }
}

/** Every helper and every Run has ended, and the newest Run answers the last result. */
const allHeard = (count) => (detail) =>
  detail.children.length >= count &&
  detail.children.every(ended) &&
  detail.runs.every((run) => run.state._tag !== 'Working') &&
  detail.runs.at(-1)?.origin._tag === 'ChildResult' &&
  detail.thread.attention !== 'Working'

/** Retain the helper rows from SQL beside the public evidence. Only a generated UUID reaches SQL. */
async function rows(state, thread, directory) {
  NodeAssert.match(thread, /^[0-9a-f-]{36}$/)
  const sql = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM vivid_child_runs WHERE thread_id='${thread}') t;`
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
  const stored = JSON.parse(output)
  await json(directory + '/vivid_child_runs.json', stored)
  return stored
}

/** The result deliveries the Thread received, one per helper the parent did not read itself. */
const wakesIn = (page) =>
  page.messages.filter((message) => message.signal?.tagName === 'child-result')

export const COMPARE = `Have two helpers read these pages at the same time, one page each: ${PAGES[0]} and ${PAGES[1]}. When both are back, tell me in two sentences what each page reserves and how they differ.`

/**
 * A real model asked to compare two pages starts two Researcher helpers; both work at once; each
 * ends with an answer; the Thread hears each result once; Vivid answers from them.
 */
export async function helpers(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Helpers require a real model')
  await chat(state, id, COMPARE, directory)
  const detail = await watchUntil(state, id, allHeard(2), directory, 'heard')
  const children = detail.children
  NodeAssert.ok(children.length >= 2, 'Vivid started fewer than two helpers')
  for (const child of children) NodeAssert.equal(child.state._tag, 'Completed', child.brief)
  const stored = await rows(state, id, directory)
  // Overlap from the server's own receipts: every helper started before any of them ended.
  const started = stored.map((row) => row.receipt).filter(Boolean)
  NodeAssert.equal(started.length, children.length, 'A helper has no runtime receipt')
  const seen = JSON.parse(await NodeFSP.readFile(directory + '/heard-seen.json', 'utf8'))
  NodeAssert.ok(
    seen.some(
      (publication) =>
        publication.children.filter((child) => child.state._tag === 'Working').length >= 2,
    ),
    'No publication shows two helpers working at once',
  )
  for (const child of children) {
    const opened = await rpc(
      state,
      'GetChildRun',
      { id: child.id },
      directory,
      'helper-' + child.number,
    )
    NodeAssert.equal(opened._tag, 'Ended')
    NodeAssert.equal(opened.result._tag, 'Completed')
    NodeAssert.ok(opened.result.text.trim().length > 0, 'A helper answered nothing')
    NodeAssert.ok(opened.result.usage.totalTokens > 0, 'A helper measured no usage')
  }
  const page = await history(state, id, directory)
  const wakes = wakesIn(page)
  NodeAssert.equal(wakes.length, children.length, 'Each helper result must reach the Thread once')
  NodeAssert.deepEqual(
    wakes.map((wake) => wake.signal.attributes.helper).sort(),
    children.map((child) => String(child.number)).sort(),
  )
  const last = page.messages.filter((message) => message.role === 'assistant').at(-1)
  NodeAssert.ok(last, 'No answer after the results came back')
  const answer = last.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
  NodeAssert.match(
    answer,
    /2606|6761|example|\.test|localhost|invalid/i,
    'The answer does not use the pages',
  )
  await json(directory + '/scope.json', {
    kinds: [...new Set(children.map((child) => child.kind))],
    proved:
      'Two or more helpers started by the real model, working at once, each answer read back, one result delivery per helper, and an answer after them.',
    blocked: helperLimits,
  })
}

export const STOPPING = `Have two helpers work at the same time. One reads ${PAGES[0]} and tells me what it reserves. The other reads each of these pages one after another and lists every section heading of each: ${LONG.join(', ')}. Tell me what both found when they are done.`

/** The slower helper, once it is at work: the one whose brief names the long pages. */
const slow = (detail) =>
  detail.children.find((child) => child.state._tag === 'Working' && child.brief.includes('9110'))

/**
 * A Person stops one working helper from the Thread. It ends Stopped by a Person; its sibling
 * goes on and completes; Vivid hears that it was stopped, once, and answers after.
 */
export async function helperstop(state, id, directory, stopper = stopByRpc) {
  NodeAssert.equal(state.modelKind, 'real', 'Helpers require a real model')
  await chat(state, id, STOPPING, directory)
  const working = await watchUntil(
    state,
    id,
    (detail) => slow(detail) !== undefined,
    directory,
    'working',
  )
  const target = slow(working)
  await stopper(state, id, directory, target)
  const detail = await watchUntil(state, id, allHeard(2), directory, 'heard')
  const stopped = detail.children.find((child) => child.id === target.id)
  NodeAssert.equal(stopped.state._tag, 'Stopped')
  NodeAssert.equal(stopped.state.by, 'Person')
  const siblings = detail.children.filter((child) => child.id !== target.id)
  NodeAssert.ok(
    siblings.some((child) => child.state._tag === 'Completed'),
    'The sibling did not finish',
  )
  const opened = await rpc(state, 'GetChildRun', { id: target.id }, directory, 'stopped-helper')
  NodeAssert.equal(opened._tag, 'Ended')
  NodeAssert.equal(opened.result._tag, 'Stopped')
  const page = await history(state, id, directory)
  const heard = wakesIn(page).filter(
    (wake) => wake.signal.attributes.helper === String(target.number),
  )
  NodeAssert.equal(heard.length, 1, 'Vivid must hear once that the helper was stopped')
  const said = heard[0].parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
  NodeAssert.match(said, /stopped by a person/i)
  await rows(state, id, directory)
  await json(directory + '/scope.json', {
    proved:
      'A Person stopped one working helper; it ended Stopped by a Person, its sibling completed, and Vivid heard the stop once and answered.',
    blocked: helperLimits,
  })
}

/** The HTTP journey stops it through the same public call the Stop control makes. */
async function stopByRpc(state, id, directory, target) {
  const run = await rpc(state, 'CancelChildRun', { id: target.id }, directory, 'cancel')
  NodeAssert.ok(['Stopping', 'Stopped'].includes(run.state._tag))
}

/** The browser sends through the composer and waits for the helper rows it draws. */
export async function helpersBrowser(state, id, directory, { run, capture }) {
  await run(['find', 'label', 'Message Vivid', 'fill', COMPARE])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  await run(['wait', '--text', 'helpers working on parts of this'])
  await capture('working')
  const detail = await watchUntil(state, id, allHeard(2), directory, 'heard')
  for (const stage of ['heard', 'reloaded']) {
    if (stage === 'reloaded') await run(['reload'])
    await run(['wait', '--text', 'helpers working on parts of this'])
    const rows = JSON.parse(
      await run([
        'eval',
        `JSON.stringify(Array.from(document.querySelectorAll('button[aria-expanded]')).map(b => b.innerText))`,
      ]),
    )
    const drawn = typeof rows === 'string' ? JSON.parse(rows) : rows
    for (const child of detail.children)
      NodeAssert.ok(
        drawn.some((text) => text.includes(child.brief.slice(0, 40)) && text.includes('Done')),
        'No Done row for helper ' + child.number,
      )
    await capture(stage)
  }
  // Opening a row shows that helper's own answer.
  const [first] = detail.children
  const opened = await rpc(state, 'GetChildRun', { id: first.id }, directory, 'opened')
  await run(['click', `li[data-helper="${first.id}"] button[aria-expanded]`])
  const words = opened.result.text.trim().split(/\s+/).slice(0, 4).join(' ')
  await run(['wait', '--text', words])
  await capture('opened')
  const after = await rpc(state, 'GetThread', { id }, directory, 'reloaded-thread')
  NodeAssert.deepEqual(after.children, detail.children, 'Reload changed the helpers')
}

/** The browser stops the slower helper with its own row's Stop. */
export async function helperstopBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  await run(['find', 'label', 'Message Vivid', 'fill', STOPPING])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  const working = await watchUntil(
    state,
    id,
    (detail) => slow(detail) !== undefined,
    directory,
    'working',
  )
  const target = slow(working)
  await run(['wait', '--text', 'helpers working on parts of this'])
  await capture('working')
  // The slow helper's own row's Stop, not the composer's.
  const stop = `li[data-helper="${target.id}"] button[aria-label="Stop this helper"]`
  await run(['wait', stop])
  await run(['click', stop])
  const detail = await watchUntil(state, id, allHeard(2), directory, 'heard')
  const stopped = detail.children.find((child) => child.id === target.id)
  NodeAssert.equal(stopped.state._tag, 'Stopped')
  NodeAssert.equal(stopped.state.by, 'Person')
  await run(['reload'])
  await run(['wait', '--text', 'Stopped'])
  await capture('reloaded')
  const page = await history(state, id, directory)
  NodeAssert.equal(
    wakesIn(page).filter((wake) => wake.signal.attributes.helper === String(target.number)).length,
    1,
  )
}
