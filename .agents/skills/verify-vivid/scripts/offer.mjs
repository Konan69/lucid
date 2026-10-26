import * as NodeAssert from 'node:assert/strict'
import { Result, Schema } from 'effect'
import { chat, history, json, settled } from './wire.mjs'

/**
 * Words a Person would send when the reply invites a short answer and no display fits: a draft
 * would be drawn as a letter whose own Send button is the next step, so the pills would not show.
 * No tool is named.
 */
export const asked = 'Do I need a jacket in Lagos this weekend?'

/**
 * The replies Vivid offered under its newest reply, read from the stored conversation
 * independently of `offeredReplies` in `@vivid/state`: the last accepted `suggest_replies` call.
 */
export function offered(page) {
  const last = page.messages.at(-1)
  if (!last || last.role !== 'assistant') return []
  const call = last.parts.findLast(
    (part) =>
      part.type === 'dynamic-tool' &&
      part.toolName === 'suggest_replies' &&
      part.state === 'output-available',
  )
  return call ? call.input.replies : []
}

/** The runtime's own limits (`SUGGESTED_REPLIES_MOST`, `SUGGESTED_REPLY_LONGEST`). */
function assertOffer(replies) {
  NodeAssert.ok(replies.length >= 1 && replies.length <= 3, 'Expected one to three replies')
  for (const words of replies)
    NodeAssert.ok(words.trim().length > 0 && words.length <= 40, 'Reply out of bounds: ' + words)
}

/** HTTP: a real reply stores one to three suggested replies on the newest assistant message. */
export async function offer(state, id, directory) {
  await chat(state, id, asked, directory)
  await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  const replies = offered(page)
  await json(directory + '/offered.json', replies)
  assertOffer(replies)
}

const Names = Schema.Array(Schema.String)
const Pills = Schema.decodeUnknownResult(
  Schema.Union([Schema.fromJsonString(Names), Schema.fromJsonString(Schema.fromJsonString(Names))]),
)

/** The suggestion pills drawn in the Thread (`thread/Replies.tsx`): their accessible names. */
const drawn = `Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim().startsWith('↪')).map(b => b.textContent.replace('↪', '').trim())`

/**
 * Browser: the stored replies are drawn under the reply and survive reload; a tap sends the
 * words as the Person's next message, and the old pills give way to the newest reply's own.
 */
export async function offerBrowser(state, id, directory, { run, capture }) {
  await run(['find', 'label', 'Message Vivid', 'fill', asked])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  await settled(state, id, 1, 'Completed', directory)
  const first = await history(state, id, directory, 'first-history')
  const replies = offered(first)
  await json(directory + '/offered.json', replies)
  assertOffer(replies)
  // agent-browser may print the evaluated string as JSON once more, as `dom` in browser.mjs allows.
  const read = async () =>
    Result.getOrThrow(Pills(await run(['eval', 'JSON.stringify(' + drawn + ')'])))
  await run(['wait', '--fn', drawn + '.length === ' + replies.length])
  NodeAssert.deepEqual(await read(), replies, 'Drawn pills differ from the stored offer')
  await capture('offered')
  await run(['reload'])
  await run(['wait', '--fn', drawn + '.length === ' + replies.length])
  NodeAssert.deepEqual(await read(), replies, 'Pills differ after reload')
  await capture('offered-reloaded')
  await run(['find', 'role', 'button', 'click', '--name', replies[0], '--exact'])
  await settled(state, id, 2, 'Completed', directory)
  const second = await history(state, id, directory, 'second-history')
  const people = second.messages.filter((m) => m.role === 'user')
  NodeAssert.equal(people.length, 2)
  const said = people[1].parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim()
  NodeAssert.equal(said, replies[0], 'The tap did not send its words')
  const next = offered(second)
  await run([
    'wait',
    '--fn',
    'JSON.stringify(' + drawn + ') === ' + JSON.stringify(JSON.stringify(next)),
  ])
  await json(directory + '/after-tap.json', { said, next })
  await capture('after-tap')
}
