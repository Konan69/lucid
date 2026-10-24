import * as NodeAssert from 'node:assert/strict'
import { Schema } from 'effect'
import { decodeText } from './receipts.mjs'
import { ConnectionState } from '@vivid/contracts'
import { rpc, json } from './wire.mjs'
import { integrationOf, watchWords, occurrence, disconnected } from './watch.mjs'

/** Real Settings controls own Connect and Disconnect; the browser composer owns the Watch request. */
export async function watchBrowser(state, id, directory, { run, capture }) {
  NodeAssert.equal(state.modelKind, 'real')
  await run(['open', state.web + '/?settings=connections'])
  await run(['wait', '[aria-label="Search integrations"]'])
  await run(['find', 'label', 'Search integrations', 'fill', 'Verify Pulse'])
  await run(['find', 'role', 'button', 'click', '--name', 'Connect Verify Pulse', '--exact'])
  await run(['wait', 'input[name=code]'])
  await run(['fill', 'input[name=code]', 'verify-pulse-local'])
  await run(['find', 'role', 'button', 'click', '--name', 'Connect', '--exact'])
  await run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll('[role="dialog"] button')).some(b => b.textContent.trim() === 'Disconnect')`,
  ])
  await capture('connected')
  const list = await rpc(state, 'ListConnections', undefined, directory)
  const connection = list.connections.find(
    (candidate) =>
      candidate.service === 'verify-pulse' && ConnectionState.guards.Ready(candidate.state),
  )
  NodeAssert.ok(connection, 'UI Connect did not create a ready Integration')
  const integration = await integrationOf(state, connection, directory)
  const marker = 'Browser pulse ' + crypto.randomUUID().slice(0, 8)
  await run(['open', state.web + '/t/' + id])
  await run(['wait', '[aria-label="Message Vivid"]'])
  await run(['find', 'label', 'Message Vivid', 'fill', watchWords(marker)])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  const proof = await occurrence(state, { id, integration, marker }, directory)
  await capture('watch-active')
  await run(['open', state.web + '/feed'])
  await run(['wait', '--text', marker])
  await run(['wait', '--text', proof.receipt])
  await capture('feed')
  await run(['reload'])
  await run(['wait', '--text', marker])
  await run(['wait', '--text', proof.receipt])
  await capture('feed-reloaded')
  await json(directory + '/visible-feed.json', { marker, item: proof.item })
  await disconnected(state, proof, directory, async () => {
    await run(['open', state.web + '/?settings=connections'])
    const available = `Array.from(document.querySelectorAll('[role="dialog"] button')).some(b => b.textContent.trim() === 'Disconnect' || b.getAttribute('aria-label') === 'Disconnect Verify Pulse')`
    await run(['wait', '--fn', available])
    const name = decodeText(
      Schema.String,
      await run([
        'eval',
        `Array.from(document.querySelectorAll('[role="dialog"] button')).some(b => b.textContent.trim() === 'Disconnect') ? 'Disconnect' : 'Disconnect Verify Pulse'`,
      ]),
    )
    await run(['find', 'role', 'button', 'click', '--name', name, '--exact'])
    await run(['wait', '--fn', '!(' + available + ')'])
    await capture('disconnected')
  })
}
