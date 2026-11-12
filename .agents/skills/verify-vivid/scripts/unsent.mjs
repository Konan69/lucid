import * as NodeAssert from 'node:assert/strict'
import * as NodeCrypto from 'node:crypto'
import { history, json, settled } from './wire.mjs'

/** The page's own store for unsent words (`apps/web/src/data/sending.ts` `UNSENT`). */
const kept = `(localStorage.getItem('vivid-unsent') ?? '')`
const alerts = `Array.from(document.querySelectorAll('p[role="alert"]')).map((p) => p.innerText).join('\\n')`

/** agent-browser prints an eval result as JSON; a JSON.stringify result arrives encoded twice. */
const parsed = (out) => {
  const once = JSON.parse(out.trim())
  return typeof once === 'string' ? JSON.parse(once) : once
}

/** The delivery keys the page stored for words holding the nonce. */
const storedKeys = (nonce) =>
  `JSON.stringify(Object.values(JSON.parse(${kept} || '{}')).flat().filter((u) => u.delivery.words.includes(${JSON.stringify(nonce)})).map((u) => u.delivery.key))`

/** The visible text of the assistant answer to one submission. */
const answer = (page, submissionId) =>
  page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === submissionId)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim()

const sent = (page, nonce) =>
  page.messages.filter(
    (message) =>
      message.role === 'user' &&
      message.parts.some((part) => part.type === 'text' && part.text.includes(nonce)),
  )

/**
 * Words sent while the browser is offline stay in the Thread as Not sent, survive a reload from
 * the browser's storage, and Send again delivers them once under their original key.
 */
export async function unsentBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  const nonce = 'unsent-' + NodeCrypto.randomUUID().slice(0, 8)
  const words = `Verification ${nonce}. Reply with the word received.`
  let keys = []
  await run(['set', 'offline', 'on'])
  try {
    await run(['find', 'label', 'Message Vivid', 'fill', words])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    await run([
      'wait',
      '--fn',
      `${alerts}.includes('Not sent.') && ${kept}.includes(${JSON.stringify(nonce)})`,
    ])
    await capture('offline-not-sent')
    keys = parsed(await run(['eval', storedKeys(nonce)]))
  } finally {
    await run(['set', 'offline', 'off'])
  }
  NodeAssert.equal(keys.length, 1, 'The page must keep the unsent words under one delivery key')
  const offline = await history(state, id, directory, 'history-offline')
  NodeAssert.equal(sent(offline, nonce).length, 0, 'Offline words reached the server')

  await run(['reload'])
  await run([
    'wait',
    '--fn',
    `${alerts}.includes('Not sent.') && document.body.innerText.includes(${JSON.stringify(nonce)})`,
  ])
  await capture('restored-after-reload')
  await run(['find', 'role', 'button', 'click', '--name', 'Send again', '--exact'])
  await settled(state, id, 1, 'Completed', directory)
  const delivered = await history(state, id, directory, 'history-delivered')
  const arrived = sent(delivered, nonce)
  NodeAssert.equal(arrived.length, 1, 'Send again must deliver the words once')
  NodeAssert.equal(arrived[0].key, keys[0], 'Send again must reuse the original delivery key')
  const reply = answer(delivered, arrived[0].submissionId)
  NodeAssert.ok(reply.length > 0, 'The delivered words must get an assistant answer')
  // The answer's opening words, as the Thread draws them after reload.
  const opening = reply.replace(/[*_`#>\[\]()]/g, '').split(/\s+/).slice(0, 4).join(' ')
  await run([
    'wait',
    '--fn',
    `!${alerts}.includes('Not sent.') && !${kept}.includes(${JSON.stringify(nonce)})`,
  ])
  await run(['reload'])
  await run([
    'wait',
    '--fn',
    `document.body.innerText.includes(${JSON.stringify(nonce)}) && document.body.innerText.includes(${JSON.stringify(opening)}) && !${alerts}.includes('Not sent.')`,
  ])
  await capture('sent-after-reload')
  await json(directory + '/scope.json', {
    nonce,
    key: keys[0],
    opening,
    proved:
      'Offline composer send kept as Not sent in browser storage under one key, restored after reload, Send again delivered once under that same key, answered, and the answer and words shown with no Not sent line after reload',
    unproved:
      'Refused and Unstarted sends, a workspace switch, a second Person on the same browser, and the phone',
  })
}
