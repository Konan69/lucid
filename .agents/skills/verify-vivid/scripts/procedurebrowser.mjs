import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { procedureSteps, taught, applied } from './procedure.mjs'
import { settled, json, rpc } from './wire.mjs'

/** No visible word of the page may speak of skills or procedures, the same rule as the replies. */
const quietPage = `!/\\b(skills?|procedures?)\\b|save_skill|read_skill|activate_skill/iu.test(document.querySelector('main') === null ? document.body.innerText : document.querySelector('main').innerText)`

/** Send one message through the composer of the open Thread. */
async function send(run, words) {
  await run(['wait', '[aria-label="Message Vivid"]'])
  await run(['find', 'label', 'Message Vivid', 'fill', words])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
}

/** The walkthrough and the later request both go through the web composer; receipts back each turn. */
export async function procedureBrowser(state, id, directory, { run, capture }) {
  assert.equal(state.modelKind, 'real', 'Teaching requires a real model; rehearsal cannot prove it')
  const steps = procedureSteps('conference expense')
  await json(directory + '/steps.json', steps)
  let detail
  for (const [index, words] of steps.teach.entries()) {
    const evidence = directory + '/teach-' + (index + 1)
    await fs.mkdir(evidence, { recursive: true })
    await send(run, words)
    detail = await settled(state, id, index + 1, 'Completed', evidence)
  }
  await taught(state, { id, detail, steps }, directory)
  await run(['wait', '--fn', quietPage])
  await capture('taught')
  const second = crypto.randomUUID()
  await rpc(state, 'CreateThread', { id: second, title: 'Expense', projectId: null }, directory)
  await run(['open', state.web + '/t/' + second])
  await send(run, steps.apply)
  const done = await settled(state, second, 1, 'Completed', directory)
  await applied(state, { id: second, detail: done, steps }, directory)
  await run(['wait', '--text', steps.code])
  await run(['wait', '--fn', quietPage])
  await capture('applied')
  await run(['reload'])
  await run(['wait', '--text', steps.code])
  await capture('applied-reloaded')
  await json(directory + '/scope.json', {
    proved:
      'The walkthrough sent through the web composer is learned once without being done and read back whole; a second Thread opened in the browser gets the corrected code, visible before and after reload, with no word about skills on the page.',
    unsupported: ['browser-recorded demonstrations', 'Company procedures', 'native clients'],
  })
}
