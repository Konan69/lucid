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

/**
 * What one step left behind. `known.file` is the entry Vivid made in the first step; the later
 * steps must change that same entry. A settled model sentence never replaces a receipt.
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
  if (step.change === 'write' || step.change === 'replace') {
    assert.equal(writes.length, 1, 'Expected one entry written in ' + step.name)
    assert.equal(deletes.length, 0, 'Unexpected delete in ' + step.name)
    const [write] = writes
    assert.equal(write.state, 'output-available')
    assert.equal(write.output.ok, true)
    assert.match(String(write.input.body), step.body)
    if (step.change === 'write') {
      assert.equal(write.output.replaced, false)
      known.file = write.input.file
      known.layer = write.output.layer
    } else {
      assert.equal(write.input.file, known.file, 'The correction made a second entry')
      assert.equal(write.output.layer, known.layer, 'The correction changed layers')
      assert.equal(write.output.replaced, true)
    }
  }
  if (step.change === 'delete') {
    assert.equal(writes.length, 0, 'Unexpected write in delete')
    assert.equal(deletes.length, 1, 'Expected one entry deleted')
    assert.equal(deletes[0].state, 'output-available')
    assert.deepEqual(deletes[0].output, {
      ok: true,
      retracted: known.file,
      layer: known.layer,
      forget_complete: false,
    })
  }
  await json(directory + '/receipt.json', {
    step: step.name,
    run,
    file: known.file,
    layer: known.layer,
    calls,
    text,
  })
  return text
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
  }
  await json(directory + '/scope.json', {
    proved:
      'Real model write, read, same-file replacement, read replacement, delete and missing read through public Thread transport.',
    unsupported: [
      'owner cancellation and idle capacity',
      'server process restart',
      'native clients',
    ],
  })
}
