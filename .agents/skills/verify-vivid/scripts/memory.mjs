import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { Tool, InputAnswer, InputRequestState } from '@vivid/contracts'
import { chat, settled, history, json, rpc } from './wire.mjs'

/**
 * The Memory journey, asked as a Person asks (the owner, 26 October 2026: stop telling it which tool
 * to use). No prompt names a tool, a file or a field. What is checked is what a Person would see
 * and what the tools leave behind: each change is exactly one write or delete with the right
 * words, a correction replaces the same entry instead of adding a second, and a question changes
 * nothing. The file is the one Vivid chose for the first entry, read from that receipt.
 */
export function memorySteps() {
  const project = 'Cedar-' + crypto.randomUUID().slice(0, 8)
  return [
    {
      name: 'create',
      prompt: `Please remember that for project ${project}, I prefer meetings before noon, because afternoons are for writing.`,
      change: 'write',
      body: /before (?:12:00 )?noon/iu,
      says: [],
    },
    {
      name: 'read-original',
      prompt: `When do I like to have meetings for project ${project}, and why?`,
      change: 'none',
      says: [/noon/iu, /writ/iu],
    },
    {
      name: 'replace',
      prompt: `That has changed: for project ${project}, I now prefer meetings after three, because mornings are for writing.`,
      change: 'replace',
      body: /after (three|3)/iu,
      says: [],
    },
    {
      name: 'read-replacement',
      prompt: `So when should you book my meetings for project ${project} now?`,
      change: 'none',
      says: [/three|3/iu],
    },
    {
      name: 'delete',
      prompt: `Please forget my meeting preference for project ${project}.`,
      change: 'delete',
      says: [],
    },
    {
      name: 'read-missing',
      prompt: `Do you still have an entry of when I like meetings for project ${project}?`,
      change: 'none',
      says: [],
    },
  ]
}

/** The tool parts of one Run, read from the Thread's history. */
function callsOf(page, run) {
  const replies = page.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === run,
  )
  const calls = replies
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool')
  const text = replies
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  return { calls, text }
}

/** The create turn writes exactly one new entry; the later steps follow its file and layer. */
function created(writes, deletes, step, known) {
  assert.equal(writes.length, 1, 'Expected one entry written in ' + step.name)
  assert.equal(deletes.length, 0, 'Unexpected delete in ' + step.name)
  const [write] = writes
  assert.equal(write.output.ok, true)
  assert.match(String(write.input.body), step.body)
  assert.equal(write.output.replaced, false)
  known.file = write.input.file
  known.layer = write.output.layer
}

/**
 * The correction turn must first rewrite the entry Vivid made, at its revision, as `KEEPING_MEMORY`
 * in `packages/agent/runtime/src/agents/vivid.ts` tells it. Vivid may then rename that entry: it
 * names a file after the value it holds, and on 28 October 2026 (run
 * pi-20261028231419043-cc2526d7, HTTP and web alike) it rewrote "…-before-noon.md", wrote the same
 * correction to "…-after-three.md" and retracted the old file in the same Run. That leaves one
 * entry with the correction, which is the outcome the feature promises; `memoryIndexed` proves no
 * second entry survives. A rename is exactly one new write plus the retraction of the old file;
 * anything else still fails, and the later steps follow the new file.
 */
function corrected(writes, deletes, step, known) {
  const [first, ...rest] = writes
  assert.ok(first, 'Expected the correction written in ' + step.name)
  assert.equal(first.input.file, known.file, 'The correction did not rewrite the entry it made')
  assert.equal(first.output.layer, known.layer, 'The correction changed layers')
  assert.equal(first.output.ok, true)
  assert.equal(first.output.replaced, true)
  assert.match(String(first.input.body), step.body)
  if (rest.length === 0 && deletes.length === 0) return
  assert.equal(rest.length, 1, 'More than one extra write in ' + step.name)
  assert.equal(deletes.length, 1, 'The correction made a second entry')
  const [moved] = rest
  assert.equal(moved.output.ok, true)
  assert.equal(moved.output.replaced, false)
  assert.equal(moved.output.layer, known.layer, 'The renamed correction changed layers')
  assert.match(String(moved.input.body), step.body)
  assert.deepEqual(deletes[0].output, {
    ok: true,
    retracted: known.file,
    layer: known.layer,
    forget_complete: false,
  })
  known.renamed = { from: known.file, to: moved.input.file }
  known.file = moved.input.file
}

/**
 * What one step left behind. `known.file` is the entry Vivid made in the first step; the later
 * steps must change that same entry, or its rename. A settled model sentence never replaces a
 * receipt.
 */
export async function memoryReceipt(page, run, step, directory, known) {
  const { calls, text } = callsOf(page, run)
  // Retain failed attempts in evidence. Require the exact successful mutation and a fresh
  // public index after a confirmed retraction; an interrupted call alone proves no outcome.
  const writes = calls.filter(
    (part) => part.toolName === Tool.write_memory && part.state === 'output-available',
  )
  const deletes = calls.filter(
    (part) => part.toolName === Tool.delete_memory && part.state === 'output-available',
  )
  assert.ok(text.length > 0, 'No assistant reply in ' + step.name)
  for (const pattern of step.says) assert.match(text, pattern, step.name + ' reply')
  if (step.change === 'none') {
    assert.equal(writes.length + deletes.length, 0, 'A question changed an entry in ' + step.name)
  }
  if (step.change === 'write') created(writes, deletes, step, known)
  if (step.change === 'replace') corrected(writes, deletes, step, known)
  if (step.change === 'delete') {
    // Forgetting is the closure, not a local retraction: the confirmed Run carries out the plan
    // and its receipt says completed only when nothing that can bring it back remains.
    const forgets = calls.filter(
      (part) => part.toolName === Tool.forget_memory && part.state === 'output-available',
    )
    assert.equal(writes.length, 0, 'Unexpected write in delete')
    assert.equal(deletes.length, 0, 'Forgetting used a local retraction instead of the closure')
    assert.equal(forgets.length, 1, 'Expected the confirmed plan carried out once')
    assert.equal(forgets[0].output.state, 'completed', 'The forget did not complete')
    assert.ok(
      forgets[0].output.done.retracted + forgets[0].output.done.rewritten >= 1,
      'The forget removed nothing from memory',
    )
  }
  await json(directory + '/receipt.json', {
    step: step.name,
    run,
    file: known.file,
    layer: known.layer,
    renamed: known.renamed ?? null,
    calls,
    text,
  })
  return text
}

/**
 * After a write or a correction, the public index must hold exactly one entry for this fixture's
 * project, and it must be the one the receipts name. This is the "no second entry" outcome, read
 * from the Person's memory rather than counted from tool calls.
 */
export async function memoryIndexed(state, step, directory, known, page, id) {
  if (step.change === 'write') await memoryCited(state, directory, known, page, id)
  if (step.change !== 'write' && step.change !== 'replace') return
  const marker = step.prompt.match(/Cedar-[a-f0-9]{8}/u)
  assert.ok(marker, 'The memory fixture has no unique project marker')
  const project = marker[0].toLowerCase()
  const index = await rpc(state, 'GetMemoryIndex', undefined, directory, 'index')
  const entries = [...index.standing, ...index.lines].filter(
    (entry) =>
      entry.file.toLowerCase().includes(project) ||
      entry.description.toLowerCase().includes(project),
  )
  assert.deepEqual(
    entries.map((entry) => ({ layer: entry.layer, file: entry.file })),
    [{ layer: known.layer, file: known.file }],
    'Expected exactly one entry for this project after ' + step.name,
  )
}

/**
 * A new entry says where it came from: a citation of the Person's own message in this Thread,
 * read through the public `ReadMemory` the Settings source link uses, whose message is in the
 * Thread's history and says the preference. The model never named it; the host did.
 */
async function memoryCited(state, directory, known, page, id) {
  const saved = await rpc(
    state,
    'ReadMemory',
    { layer: known.layer, file: known.file },
    directory,
    'cited',
  )
  const messages = saved.citations.filter(
    (citation) => citation._tag === 'ThreadMessage' && citation.threadId === id,
  )
  assert.ok(messages.length > 0, 'The new entry cites no message of this Thread')
  const said = page.messages.filter(
    (message) =>
      message.purpose === 'user' && messages.some((citation) => citation.messageId === message.id),
  )
  assert.ok(said.length > 0, 'The cited message is not in the Thread history')
  assert.ok(
    said.some((message) =>
      message.parts.some(
        (part) => part.type === 'text' && /before (?:12:00 )?noon/iu.test(part.text),
      ),
    ),
    'The cited message is not the one that said the preference',
  )
}

/** The shipped forget-something skill plans first. Confirm only this fixture's single entry,
 * through the real question card on web or AnswerInput on HTTP, then observe its Decision Run. */
export async function confirmMemory(state, { id, detail, directory, step, known }, answer) {
  const marker = step.prompt.match(/Cedar-[a-f0-9]{8}/u)
  assert.ok(marker, 'The forgetting fixture has no unique project marker')
  const waiting = detail.requests.filter(
    (request) =>
      InputRequestState.guards.Waiting(request.state) &&
      request.questions.some((question) => question.question.includes(marker[0])),
  )
  assert.equal(waiting.length, 1, 'Expected one confirmation for this fixture project')
  // The plan was made before the question, by meaning, with nothing changed yet.
  const planned = callsOf(
    await history(state, id, directory, 'planned-history'),
    detail.runs[detail.runs.length - 1].submissionId,
  ).calls.filter((part) => part.toolName === Tool.plan_forget && part.state === 'output-available')
  assert.ok(planned.length > 0, 'Vivid asked to forget without a plan')
  const request = waiting[0]
  assert.equal(request.questions.length, 1)
  assert.equal(request.questions[0].selection, 'One')
  const options = request.questions[0].options.filter(
    (option) => /^yes\b/iu.test(option.label) && /delete|forget|remove/iu.test(option.label),
  )
  assert.equal(options.length, 1, 'Expected one affirmative option for the named entry')
  const label = options[0].label
  await json(directory + '/confirmation.json', { request, label })
  await answer({ request, label })
  const confirmed = await settled(state, id, detail.runs.length + 1, 'Completed', directory)
  const completed = confirmed.requests.find((entry) => entry.id === request.id)
  assert.ok(InputRequestState.guards.Answered(completed.state))
  assert.deepEqual(completed.state.answers, [InputAnswer.cases.Chosen.make({ labels: [label] })])
  const index = await rpc(state, 'GetMemoryIndex', undefined, directory, 'forgotten-index')
  assert.ok(
    ![...index.standing, ...index.lines].some(
      (entry) => entry.layer === known.layer && entry.file === known.file,
    ),
    'The confirmed memory entry remains in the public index',
  )
  return confirmed
}

/** Person gateway admission and WatchThread settlement exercise shipped Memory tools without fixtures. */
export async function memory(state, id, directory) {
  assert.equal(state.modelKind, 'real', 'Memory requires a real model; rehearsal cannot prove it')
  const steps = memorySteps()
  await json(
    directory + '/steps.json',
    steps.map(({ name, prompt, change }) => ({ name, prompt, change })),
  )
  const known = { file: undefined }
  let count = 0
  for (const step of steps) {
    const evidence = directory + '/' + step.name
    await fs.mkdir(evidence, { recursive: true })
    await chat(state, id, step.prompt, evidence)
    let detail = await settled(state, id, count + 1, 'Completed', evidence)
    if (step.change === 'delete')
      detail = await confirmMemory(
        state,
        { id, detail, directory: evidence, step, known },
        ({ request, label }) =>
          rpc(
            state,
            'AnswerInput',
            { id: request.id, answers: [InputAnswer.cases.Chosen.make({ labels: [label] })] },
            evidence,
          ),
      )
    count = detail.runs.length
    const page = await history(state, id, evidence)
    await memoryReceipt(page, detail.runs[count - 1].submissionId, step, evidence, known)
    await memoryIndexed(state, step, evidence, known, page, id)
  }
  await json(directory + '/scope.json', {
    proved:
      'Real model write with a citation of the Person’s message, read, same-entry replacement (or its rename, one entry left in the index), read replacement, a planned and confirmed forget whose closure answers completed, and a missing read, through public Thread transport.',
    unsupported: [
      'owner cancellation and idle capacity',
      'server process restart',
      'native clients',
    ],
  })
}
