import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { noteSteps, noteReceipt } from './notes.mjs'
import { settled, history, json } from './wire.mjs'

/** The composer drives every mutation; public receipts corroborate visible replies before and after reload. */
export async function noteBrowser(state, id, directory, browser) {
  assert.equal(state.modelKind, 'real', 'Notes requires a real model; rehearsal cannot prove it')
  const { run, capture, reply } = browser
  const steps = noteSteps()
  await json(directory + '/steps.json', steps)
  for (const [index, step] of steps.entries()) {
    const evidence = directory + '/' + step.name
    await fs.mkdir(evidence, { recursive: true })
    await run(['find', 'label', 'Message Vivid', 'fill', step.prompt])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    const detail = await settled(state, id, index + 1, 'Completed', evidence)
    const page = await history(state, id, evidence)
    const text = await noteReceipt(page, detail.runs[index].id, step, evidence)
    await reply(text, evidence, 'after')
    await capture(step.name + '-after')
    await run(['reload'])
    await run(['wait', '[aria-label="Message Vivid"]'])
    await reply(text, evidence, 'reloaded')
    await capture(step.name + '-reloaded')
    const reloaded = await history(state, id, evidence, 'reloaded-history')
    assert.deepEqual(reloaded.messages, page.messages)
    assert.equal(reloaded.messages.filter((message) => message.role === 'user').length, index + 1)
  }
  await json(directory + '/scope.json', {
    proved:
      'Web composer write, read, same-file replacement, read replacement, delete and missing read. Each tool receipt is checked and each reply survives reload.',
    unsupported: [
      'Dedicated Notes list or editor; Notes are only exposed through the agent in this client',
      'owner cancellation and idle capacity',
      'server process restart',
      'native phone and desktop controls',
    ],
  })
}
