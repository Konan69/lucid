import * as NodeAssert from 'node:assert/strict'
import { Result, Schema } from 'effect'
import { decodeText } from './receipts.mjs'
import { ConnectionState, NotificationOpens } from '@vivid/contracts'
import { rpc, json } from './wire.mjs'
import { integrationOf, watchWords, occurrence, disconnected } from './watch.mjs'
import { grant, turnOn, shown, waitShown, decodeShown, decodeTabs } from './push.mjs'

/**
 * Real Settings controls own Connect, notifications and Disconnect; the browser composer owns the
 * Watch request. The grant is held for the whole journey (`grant`, `push.mjs`).
 */
export async function watchBrowser(state, id, directory, browser) {
  const granted = await grant(state, browser.run)
  try {
    await journey(state, id, directory, browser)
  } finally {
    granted.close()
  }
}

/**
 * The Feed post the event makes reaches this browser through the push service: the app's tab is
 * put behind another while the provider emits, and the worker must show the `posted` notice,
 * opening the Feed. Headless Chrome draws no notification to press, so the press itself is not
 * driven: the page is handed the payload the worker would hand it (`worker/main.ts` `open`) and
 * must go to the Feed on its own.
 */
async function journey(state, id, directory, { run, capture }) {
  NodeAssert.equal(state.modelKind, 'real')
  await turnOn(state, id, { run, capture })
  await run(['open', state.web + '/?settings=connections'])
  await run(['wait', '[aria-label="Search integrations"]'])
  await run(['find', 'label', 'Search integrations', 'fill', 'Verify Pulse'])
  await run(['wait', '[aria-label="Connect Verify Pulse"]'])
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
  const app = Result.getOrThrow(decodeTabs(await run(['tab', '--json']))).data.tabs.find(
    (tab) => tab.active,
  )
  NodeAssert.ok(app, 'Missing the app tab')
  const away = async () => {
    await run(['tab', 'new', 'about:blank'])
  }
  const proof = await occurrence(state, { id, integration, marker, away }, directory)
  await run(['tab', app.tabId])
  await capture('watch-active')
  const title = JSON.stringify(proof.item.post.title)
  await waitShown(run, `n => n.title === ${title}`)
  const notifications = Result.getOrThrow(decodeShown(await run(['eval', shown])))
  await json(directory + '/notifications.json', notifications)
  const mine = notifications.find((n) => n.title === proof.item.post.title)
  NodeAssert.deepEqual(
    mine.data.opens,
    NotificationOpens.cases.Feed.make({}),
    'The posted notice opens the Feed',
  )
  NodeAssert.equal(mine.data.notificationId, proof.notice, 'The worker shows the posted notice')
  await run([
    'eval',
    `navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(mine.data)} }))`,
  ])
  await run(['wait', '--fn', `location.pathname === '/feed'`])
  // A drawn card is named by its title but does not write it: the card is found by its name and
  // holds the receipt in its drawing, with no title heading and no sentence of ours around it.
  const card = `document.querySelector('article[aria-label=${JSON.stringify(JSON.stringify(marker)).slice(1, -1)}]')`
  await run(['wait', '--fn', `${card} !== null`])
  await run(['wait', '--text', proof.receipt])
  const ours = decodeText(
    Schema.Number,
    await run([
      'eval',
      `${card}.querySelectorAll(':scope > h2, :scope > p, :scope > footer').length`,
    ]),
  )
  NodeAssert.equal(ours, 0, 'The Feed card frames its drawing with a title, words or a bar')
  await capture('feed')
  await run(['reload'])
  await run(['wait', '--fn', `${card} !== null`])
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
    await run([
      'wait',
      '--fn',
      `!Array.from(document.querySelectorAll('[role="dialog"] h4')).some(heading => heading.textContent.trim() === 'Verify Pulse')`,
    ])
    await capture('disconnected')
  })
}
