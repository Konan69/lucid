import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import { chat, settled, history, json } from './wire.mjs'

/** One unique file keeps repeated HTTP and browser journeys independent in the same Person store. */
export function noteSteps() {
  const file = 'verify-' + crypto.randomUUID().replaceAll('-', '') + '.md'
  const original = {
    kind: 'preference',
    description: 'Meetings before noon',
    note: 'I prefer meetings before noon.\nWhy: Afternoons are for writing.\nHow to apply: Offer morning meetings.',
  }
  const replacement = {
    kind: 'preference',
    description: 'Meetings after three',
    note: 'I prefer meetings after three.\nWhy: Mornings are for writing.\nHow to apply: Offer meetings after three.',
  }
  const write = (value) => JSON.stringify({ file, ...value })
  return [
    {
      name: 'create',
      file,
      tool: Tool.write_note,
      prompt: `Remember my standing meeting preference with write_note using exactly these fields: ${write(original)}. Do not write another note. Briefly acknowledge the preference.`,
      output: { ok: true, file, replaced: false },
    },
    {
      name: 'read-original',
      file,
      tool: Tool.read_note,
      prompt: `Call read_note for ${file} and tell me my meeting preference and its reason. Read the whole note even if its summary is enough. Do not change any notes.`,
      output: original,
    },
    {
      name: 'replace',
      file,
      tool: Tool.write_note,
      prompt: `My standing meeting preference has changed. Use write_note to replace ${file} with exactly these fields: ${write(replacement)}. Keep the same file and do not create another note. Briefly acknowledge the correction.`,
      output: { ok: true, file, replaced: true },
    },
    {
      name: 'read-replacement',
      file,
      tool: Tool.read_note,
      prompt: `Call read_note for ${file} again. Tell me my corrected meeting preference and its reason. Read the whole note and do not change it.`,
      output: replacement,
    },
    {
      name: 'delete',
      file,
      tool: Tool.delete_note,
      prompt: `Forget my meeting preference by calling delete_note for ${file}. Do not keep a replacement. Briefly acknowledge that you forgot the preference.`,
      output: { ok: true, deleted: file },
    },
    {
      name: 'read-missing',
      file,
      tool: Tool.read_note,
      prompt: `Check that you forgot my preference by calling read_note for ${file}, even though it is no longer listed. Report that it is missing. Do not recreate it or use conversation history as a substitute for the tool call.`,
      output: {
        ok: false,
        message: `You have no note called ${file}; use a file name from the list of what you remember.`,
      },
    },
  ]
}

/** A settled model sentence cannot replace the actual tool receipt from this exact Run. */
export async function noteReceipt(page, run, step, directory) {
  const replies = page.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === run,
  )
  const calls = replies
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool')
  const matching = calls.filter((part) => part.toolName === step.tool)
  assert.equal(matching.length, 1, 'Expected one ' + step.tool + ' in ' + step.name)
  const receipt = matching[0]
  assert.equal(receipt.state, 'output-available')
  assert.equal(receipt.input.file, step.file)
  assert.deepEqual(receipt.output, step.output)
  const mutations = calls.filter(
    (part) => part.toolName === Tool.write_note || part.toolName === Tool.delete_note,
  )
  assert.equal(mutations.length, step.tool === Tool.read_note ? 0 : 1, 'Unexpected note mutation')
  const text = replies
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  assert.ok(text.length > 0, 'No assistant reply in ' + step.name)
  await json(directory + '/receipt.json', { step: step.name, run, receipt, text })
  return text
}

/** Person gateway admission and WatchThread settlement exercise shipped Notes tools without fixtures. */
export async function notes(state, id, directory) {
  assert.equal(state.modelKind, 'real', 'Notes requires a real model; rehearsal cannot prove it')
  const steps = noteSteps()
  await json(directory + '/steps.json', steps)
  for (const [index, step] of steps.entries()) {
    const evidence = directory + '/' + step.name
    await fs.mkdir(evidence, { recursive: true })
    await chat(state, id, step.prompt, evidence)
    const detail = await settled(state, id, index + 1, 'Completed', evidence)
    const page = await history(state, id, evidence)
    await noteReceipt(page, detail.runs[index].id, step, evidence)
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
