import * as NodeAssert from 'node:assert/strict'
import * as NodeCrypto from 'node:crypto'
import { history, json, settled } from './wire.mjs'

/** The page's own store for unsent words (`apps/web/src/data/sending.ts` `UNSENT`). */
const kept = `(localStorage.getItem('vivid-unsent') ?? '')`
const alerts = `Array.from(document.querySelectorAll('p[role="alert"]')).map((p) => p.innerText).join('\\n')`

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
  } finally {
    await run(['set', 'offline', 'off'])
  }
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
  NodeAssert.equal(sent(delivered, nonce).length, 1, 'Send again must deliver the words once')
  await run([
    'wait',
    '--fn',
    `!${alerts}.includes('Not sent.') && !${kept}.includes(${JSON.stringify(nonce)})`,
  ])
  await run(['reload'])
  await run([
    'wait',
    '--fn',
    `document.body.innerText.includes(${JSON.stringify(nonce)}) && !${alerts}.includes('Not sent.')`,
  ])
  await capture('sent-after-reload')
  await json(directory + '/scope.json', {
    nonce,
    proved:
      'Offline composer send kept as Not sent in browser storage, restored after reload, Send again delivered once and the line gone after reload',
    unproved:
      'Refused and Unstarted sends, a workspace switch, a second Person on the same browser, and the phone',
  })
}
