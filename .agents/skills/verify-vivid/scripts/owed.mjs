import * as assert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import { chat, history, json, rpc, settled } from './wire.mjs'

/**
 * What a Person says when someone owes them something. No tool, field or date format is named
 * (the owner, 26 October 2026: ask as a Person asks).
 */
export const OWED_PROMPT =
  'Tunde promised to send me the Q4 deck with the new numbers by Friday. Can you keep an eye on that for me?'

/** The record the prompt should leave: who owes it and what, in the Person's words. */
const party = /tunde/iu
const thing = /deck/iu

/** The one record this journey tracked, read through the public list. */
export async function trackedRecord(state, directory, name) {
  const listed = await rpc(state, 'ListOwed', undefined, directory, name)
  const matching = listed.owed.filter(
    (record) => party.test(record.from) && thing.test(record.what),
  )
  assert.equal(
    matching.length,
    1,
    'Expected one record of what Tunde owes, found ' + matching.length,
  )
  return matching[0]
}

/**
 * The Thread step that tracked it: exactly one successful `track_owed` call in the Run, so the
 * Person's sentence became a record and not just a reply.
 */
export async function trackedReceipt(state, id, run, directory) {
  const page = await history(state, id, directory)
  const calls = page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === run)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.toolName === Tool.track_owed)
  await json(directory + '/track-calls.json', calls)
  assert.equal(calls.length, 1, 'Expected one track_owed call, found ' + calls.length)
  assert.equal(calls[0].state, 'output-available')
  return calls[0]
}

/**
 * The waiting-on journey through the server's public surfaces: the Person tells Vivid in a Thread
 * that Tunde owes them a deck, the record appears in the list the Feed draws (`ListOwed`, the same
 * projection `WatchOwed` publishes), and closing it the way the Feed's row does (`ResolveOwed`)
 * takes it off the open list while the server keeps it as Resolved.
 */
export async function owed(state, id, directory) {
  assert.equal(state.modelKind, 'real', 'Tracking needs a real model; rehearsal cannot prove it')
  await chat(state, id, OWED_PROMPT, directory)
  const detail = await settled(state, id, 1, 'Completed', directory)
  await trackedReceipt(state, id, detail.runs[0].id, directory)
  const record = await trackedRecord(state, directory, 'listed')
  assert.equal(record.threadId, id, 'The record names another Thread')
  assert.ok(['Open', 'Nudged'].includes(record.state._tag), 'The new record is not open')
  await rpc(
    state,
    'ResolveOwed',
    { id: record.id, how: 'The Person marked it received on the Feed.' },
    directory,
  )
  const closed = await trackedRecord(state, directory, 'resolved')
  assert.equal(closed.state._tag, 'Resolved', 'Resolving did not close the record')
  await json(directory + '/scope.json', {
    proved:
      'Real model tracks a promise said in a Thread; the record is listed with its Thread; the Feed close RPC resolves it.',
    unsupported: ['chasing (nudges) over time', 'native phone and desktop controls'],
  })
}
