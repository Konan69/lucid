import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { Schema } from 'effect'
import { decodeText } from './receipts.mjs'
import { command } from './process.mjs'
import { observe } from './observation.mjs'
import { admit, history, json, rpc, settled } from './wire.mjs'

const Stored = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal('finished'),
    conversation_id: Schema.String,
    published_at: Schema.NullOr(Schema.Finite),
  }),
)

/** Two immediate admissions must actually share a response before the duplicate-notice assertion applies. */
export async function completion(state, _id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'Completion notices require a real model')
  for (const count of [1, 2]) {
    const target = directory + '/' + (count === 2 ? 'joined' : 'single')
    await NodeFSP.mkdir(target, { recursive: true })
    const id = crypto.randomUUID()
    const title = 'Completion ' + crypto.randomUUID().slice(0, 8)
    await rpc(state, 'CreateThread', { id, title, projectId: null }, target)
    // The browser remains on another Thread. No Presence stream is held for the target.
    await admit(state, id, 'What is 7 plus 8? Answer in one short sentence.', target, 'first')
    if (count === 2)
      await admit(state, id, 'Also tell me what 8 plus 9 is, in the same reply.', target, 'second')
    const detail = await settled(state, id, count, 'Completed', target)
    await history(state, id, target)
    const responses = detail.runs.map((run) => {
      NodeAssert.ok(
        run.outcome && ['Completed', 'Delivered'].includes(run.outcome._tag),
        'Missing response identity',
      )
      return run.outcome.responseId
    })
    NodeAssert.equal(
      new Set(responses).size,
      1,
      'blocked: the two messages were not answered by one response',
    )
    const list = await observe(state, {
      tag: 'WatchNotifications',
      payload: {},
      accept: (value) =>
        value.notifications.some((notice) => notice.threadId === id && notice.kind === 'finished'),
    })
    await json(target + '/notifications.json', list)
    const notices = list.notifications.filter(
      (notice) => notice.threadId === id && notice.kind === 'finished',
    )
    const output = await command([
      'docker',
      'exec',
      state.container,
      'psql',
      '-U',
      'verify',
      '-d',
      'verify',
      '-At',
      '-c',
      `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT id, kind, conversation_id, published_at FROM vivid_notifications WHERE conversation_id='${id}' AND kind='finished') t;`,
    ])
    const stored = decodeText(Stored, output)
    await json(target + '/database.json', stored)
    NodeAssert.equal(stored.length, 1, 'Expected one stored completion notice per reply')
    NodeAssert.equal(notices.length, 1, 'Expected one completion notice in the public client list')
    NodeAssert.equal(stored[0].id, notices[0].id)
    if (browser) {
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Notifications', '--exact'])
      await browser.run([
        'wait',
        '--fn',
        `Array.from(document.querySelectorAll('[aria-label="Notifications"] li')).filter(row => row.innerText.includes(${JSON.stringify(title)})).length === 1`,
      ])
      await browser.capture('notice-' + count)
      await browser.run(['press', 'Escape'])
    }
    await json(target + '/proof.json', {
      verdict: 'proved',
      thread: id,
      responses,
      notification: notices[0].id,
    })
  }
}
