import * as NodeAssert from 'node:assert/strict'
import { json, rpc } from './wire.mjs'

export const readLimits = [
  'Failed-claim retry needs a genuine MarkThreadRead refusal while the same Thread remains readable, followed by recovery. No public trigger is configured; never intercept responses.',
  'An offscreen model reply needs a working real provider and an observable Run/publication. The metadata update recipe does not prove that case.',
  'Phone and desktop native entry points need their own device runs.',
]

/** Establish the public read contract on an empty Thread without invoking a model or writing fixtures. */
export async function reading(state, id, directory) {
  const before = await rpc(state, 'GetThread', { id }, directory, 'before-read')
  NodeAssert.deepEqual(before.runs, [])
  await rpc(state, 'MarkThreadRead', { id }, directory, 'read-once')
  await rpc(state, 'MarkThreadRead', { id }, directory, 'read-again')
  const after = await rpc(state, 'GetThread', { id }, directory, 'after-read')
  NodeAssert.deepEqual(after.thread, before.thread, 'Read receipts must not advance the Thread')
  NodeAssert.deepEqual(after.runs, [])
  await json(directory + '/scope.json', {
    modelCalls: 0,
    scope:
      'Public read writes accept a repeated receipt without moving an empty Thread. Client suppression, eviction and background observation require browser reading.',
    blocked: readLimits,
  })
}
