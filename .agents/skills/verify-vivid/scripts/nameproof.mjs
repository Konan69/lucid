import * as NodeAssert from 'node:assert/strict'
import { chat, history, json, rpc, settled } from './wire.mjs'

/**
 * Names nothing in the disposable account suggests, so only the prompt can supply them. HTTP and
 * browser share one account, so each recipe gives its own name and either may run first.
 */
export const NAME = 'Juniper Okafor'
export const BROWSER_NAME = 'Marisol Achebe'

export const nameLimits = [
  'The phone sheet is proved by `verify phone name` on Android; the iPhone needs the phone itself or a macOS runner.',
  'A shared Thread names the Person who sent each message; a disposable Company with two Persons is needed to prove it.',
  'A name a sign-in provider gave that is not one line of plain text is not said to the model; no provider sign-in is available here.',
]

/** The last Vivid reply's text, which must say the new first name. */
export function answered(page, name = NAME) {
  const last = page.messages.findLast((message) => message.role === 'assistant')
  NodeAssert.ok(last, 'No Vivid reply')
  const reply = last.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  NodeAssert.match(
    reply,
    new RegExp(name.split(' ')[0], 'iu'),
    'Vivid did not answer with the new name',
  )
  return reply
}

/** Rename through the public RPC, then ask in a Person's words; Vivid's answer names them. */
export async function nameProof(state, id, directory) {
  const before = await rpc(state, 'Me', undefined, directory, 'me-before')
  NodeAssert.notEqual(before.person.name, NAME, 'Recipe needs a Person not yet called ' + NAME)
  const saved = await rpc(state, 'SetPersonName', { name: NAME }, directory, 'rename')
  NodeAssert.equal(saved.person.name, NAME)
  const after = await rpc(state, 'Me', undefined, directory, 'me-after')
  NodeAssert.equal(after.person.name, NAME)
  await chat(state, id, 'what’s my name?', directory)
  await settled(state, id, 1, 'Completed', directory)
  const reply = answered(await history(state, id, directory))
  await json(directory + '/scope.json', { reply, name: NAME, blocked: nameLimits })
}
