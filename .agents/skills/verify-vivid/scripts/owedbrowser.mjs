import * as assert from 'node:assert/strict'
import { OWED_PROMPT, trackedReceipt, trackedRecord } from './owed.mjs'
import { json, settled } from './wire.mjs'

/** Whether the Feed draws a waiting-on row naming the record, read from the rendered page. */
const rowShown = (what) => `(() => {
  const list = document.querySelector('[aria-labelledby="owed-heading"]')
  return Boolean(list && Array.from(list.querySelectorAll('li')).some((row) => !row.hasAttribute('data-folded') && row.innerText.includes(${JSON.stringify(what)})))
})()`

/**
 * The Person tells Vivid in a Thread, through the composer, that Tunde owes them a deck; opens the
 * Feed and sees the row under "Waiting on"; presses its check; the row folds away and stays gone
 * after a reload, and the public list says the record is Resolved.
 */
export async function owedBrowser(state, id, directory, { run, capture }) {
  assert.equal(state.modelKind, 'real', 'Tracking needs a real model; rehearsal cannot prove it')
  await run(['find', 'label', 'Message Vivid', 'fill', OWED_PROMPT])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  const detail = await settled(state, id, 1, 'Completed', directory)
  await trackedReceipt(state, id, detail.runs[0].id, directory)
  const record = await trackedRecord(state, id, directory, 'listed')
  await capture('thread')

  await run(['open', state.web + '/feed'])
  await run(['wait', '--text', 'Waiting on'])
  await run(['wait', '--fn', rowShown(record.what)])
  await capture('feed')

  await run([
    'find',
    'role',
    'button',
    'click',
    '--name',
    'Received from ' + record.from,
    '--exact',
  ])
  await run(['wait', '--fn', '!' + rowShown(record.what)])
  await capture('received')

  await run(['reload'])
  await run(['wait', '[aria-label="Message Vivid"]'])
  const after = await run(['eval', rowShown(record.what)])
  assert.equal(after.trim(), 'false', 'The received row came back after reload')
  const closed = await trackedRecord(state, id, directory, 'resolved')
  assert.equal(closed.state._tag, 'Resolved', 'The Feed press did not resolve the record')
  await capture('reloaded')
  await json(directory + '/scope.json', {
    proved:
      'Composer message tracked by the real model, the row on the web Feed, its check resolving it, folded at once and absent after reload.',
    unsupported: [
      'Stop waiting through the row menu',
      'chasing (nudges) over time',
      'native phone and desktop controls',
    ],
  })
}
