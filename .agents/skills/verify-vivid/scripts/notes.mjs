import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import { chat, settled, history, json } from './wire.mjs'

/**
 * The Notes journey, asked as a Person asks (the owner, 26 October 2026: stop telling it which tool
 * to use). No prompt names a tool, a file or a field. What is checked is what a Person would see
 * and what the tools leave behind: each change is exactly one write or delete with the right
 * words, a correction replaces the same note instead of adding a second, and a question changes
 * nothing. The file is the one Vivid chose for the first note, read from that receipt.
 */
export function noteSteps() {
  return [
    {
      name: 'create',
      prompt:
        'Please remember that I prefer meetings before noon, because afternoons are for writing.',
      change: 'write',
      note: /before (?:12:00 )?noon/iu,
      says: [],
    },
    {
      name: 'read-original',
      prompt: 'When do I like to have meetings, and why?',
      change: 'none',
      says: [/noon/iu, /writ/iu],
    },
    {
      name: 'replace',
      prompt:
        'That has changed: I now prefer meetings after three, because mornings are for writing.',
      change: 'replace',
      note: /after (three|3)/iu,
      says: [],
    },
    {
      name: 'read-replacement',
      prompt: 'So when should you book my meetings now?',
      change: 'none',
      says: [/three|3/iu],
    },
    {
      name: 'delete',
      prompt: 'Please forget my meeting preference.',
      change: 'delete',
      says: [],
    },
    {
      name: 'read-missing',
      prompt: 'Do you still have a note of when I like meetings?',
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
 * What one step left behind. `known.file` is the note Vivid made in the first step; the later
 * steps must change that same note. A settled model sentence never replaces a receipt.
 */
export async function noteReceipt(page, run, step, directory, known) {
  const { calls, text } = callsOf(page, run)
  const writes = calls.filter((part) => part.toolName === Tool.write_note)
  const deletes = calls.filter((part) => part.toolName === Tool.delete_note)
  assert.ok(text.length > 0, 'No assistant reply in ' + step.name)
  for (const pattern of step.says) assert.match(text, pattern, step.name + ' reply')
  if (step.change === 'none') {
    assert.equal(writes.length + deletes.length, 0, 'A question changed a note in ' + step.name)
  }
  if (step.change === 'write' || step.change === 'replace') {
    assert.equal(writes.length, 1, 'Expected one note written in ' + step.name)
    assert.equal(deletes.length, 0, 'Unexpected delete in ' + step.name)
    const [write] = writes
    assert.equal(write.state, 'output-available')
    assert.equal(write.output.ok, true)
    assert.match(String(write.input.note), step.note)
    if (step.change === 'write') {
      assert.equal(write.output.replaced, false)
      known.file = write.input.file
      known.layer = write.output.layer
    } else {
      assert.equal(write.input.file, known.file, 'The correction made a second note')
      assert.equal(write.output.layer, known.layer, 'The correction changed layers')
      assert.equal(write.output.replaced, true)
    }
  }
  if (step.change === 'delete') {
    assert.equal(writes.length, 0, 'Unexpected write in delete')
    assert.equal(deletes.length, 1, 'Expected one note deleted')
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

/** Person gateway admission and WatchThread settlement exercise shipped Notes tools without fixtures. */
export async function notes(state, id, directory) {
  assert.equal(state.modelKind, 'real', 'Notes requires a real model; rehearsal cannot prove it')
  const steps = noteSteps()
  await json(
    directory + '/steps.json',
    steps.map(({ name, prompt, change }) => ({ name, prompt, change })),
  )
  const known = { file: undefined }
  for (const [index, step] of steps.entries()) {
    const evidence = directory + '/' + step.name
    await fs.mkdir(evidence, { recursive: true })
    await chat(state, id, step.prompt, evidence)
    const detail = await settled(state, id, index + 1, 'Completed', evidence)
    const page = await history(state, id, evidence)
    await noteReceipt(page, detail.runs[index].submissionId, step, evidence, known)
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
