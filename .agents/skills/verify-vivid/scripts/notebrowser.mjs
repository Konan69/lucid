import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { noteSteps, noteReceipt } from './notes.mjs'
import { settled, history, json } from './wire.mjs'

/** CopyWords marks each finished text reply; its sequence must reach this Run, even when words repeat. */
async function latestReply(browser, page, currentRun, { directory, stage }) {
  const replies = page.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0),
  )
  const message = replies.at(-1)
  assert.ok(message, 'No assistant text message in current history')
  assert.equal(message.submissionId, currentRun, 'Latest reply does not belong to current Run')
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
  const normalised = await browser.render(text)
  assert.ok(normalised.length > 0, 'Assistant reply is empty after normalisation')
  const expression = `(() => {
    const buttons = Array.from(document.querySelectorAll('button[aria-label="Copy message"]'))
    const latest = buttons.at(-1)
    const matches = Boolean(latest && Array.from(latest.parentElement.parentElement.children).some(element => element !== latest.parentElement && (${browser.normalise.toString()})(element.innerText) === ${JSON.stringify(normalised)}))
    return { count: buttons.length, matches }
  })()`
  await browser.run([
    'wait',
    '--fn',
    `(() => { const reply = ${expression}; return reply.count === ${replies.length} && reply.matches })()`,
  ])
  const result = JSON.parse(await browser.run(['eval', 'JSON.stringify(' + expression + ')']))
  const visible = typeof result === 'string' ? JSON.parse(result) : result
  await json(directory + '/' + stage + '-reply.json', {
    stage,
    run: currentRun,
    message: message.id,
    text,
    normalised,
    expectedCount: replies.length,
    ...visible,
    expression,
  })
  assert.equal(visible.count, replies.length, 'Visible reply sequence differs from history')
  assert.equal(visible.matches, true, 'Latest visible reply differs from current Run message')
}

/** The composer drives every mutation; public receipts corroborate visible replies before and after reload. */
export async function noteBrowser(state, id, directory, browser) {
  assert.equal(state.modelKind, 'real', 'Notes requires a real model; rehearsal cannot prove it')
  const { run, capture } = browser
  const steps = noteSteps()
  await json(
    directory + '/steps.json',
    steps.map(({ name, prompt, change }) => ({ name, prompt, change })),
  )
  const known = { file: undefined }
  for (const [index, step] of steps.entries()) {
    const evidence = directory + '/' + step.name
    await fs.mkdir(evidence, { recursive: true })
    await run(['find', 'label', 'Message Vivid', 'fill', step.prompt])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    const detail = await settled(state, id, index + 1, 'Completed', evidence)
    const page = await history(state, id, evidence)
    const currentRun = detail.runs[index].submissionId
    await noteReceipt(page, currentRun, step, evidence, known)
    await latestReply(browser, page, currentRun, { directory: evidence, stage: 'after' })
    await capture(step.name + '-after')
    await run(['reload'])
    await run(['wait', '[aria-label="Message Vivid"]'])
    const reloaded = await history(state, id, evidence, 'reloaded-history')
    assert.deepEqual(reloaded.messages, page.messages)
    assert.equal(reloaded.messages.filter((message) => message.role === 'user').length, index + 1)
    await latestReply(browser, reloaded, currentRun, { directory: evidence, stage: 'reloaded' })
    await capture(step.name + '-reloaded')
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
