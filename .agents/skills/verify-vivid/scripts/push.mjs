import * as NodeAssert from 'node:assert/strict'
import { PushDestination, PushPayload } from '@vivid/contracts'
import { Result, Schema } from 'effect'
import { json, rpc, chat, settled } from './wire.mjs'
import { connect } from './cdp.mjs'

const ROW = 'Notify me when something needs me'
const TITLE = 'Verify push'
const BODY = 'The check is done.'

/** What `getNotifications` shows, as the page serialises it; `data` is the worker's payload. */
const Shown = Schema.Array(
  Schema.Struct({
    title: Schema.String,
    body: Schema.String,
    tag: Schema.String,
    data: PushPayload,
  }),
)
const decodeShown = Schema.decodeUnknownResult(Schema.fromJsonString(Shown))
const decodeLabel = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String))
/** `agent-browser tab --json`: tabs carry stable ids like `t1`; positions are not accepted. */
const Tabs = Schema.Struct({
  data: Schema.Struct({
    tabs: Schema.Array(Schema.Struct({ tabId: Schema.String, active: Schema.Boolean })),
  }),
})
const decodeTabs = Schema.decodeUnknownResult(Schema.fromJsonString(Tabs))

/** This browser's targets among a list: the Person's phone may hold others. */
const browsersIn = (list) =>
  list.targets.filter((t) => PushDestination.guards.Browser(t.destination))

/** HTTP: the server hands out the public key a browser subscribes with, and lists targets. */
export async function pushProof(state, _id, directory) {
  const key = await rpc(state, 'GetPushKey', undefined, directory, 'key')
  NodeAssert.match(key.publicKey, /^[A-Za-z0-9_-]{87}$/u)
  // The answer is decoded with the shipped schema (`rpc`): a target the contract does not
  // describe fails there.
  await rpc(state, 'ListPushTargets', undefined, directory, 'targets')
}

/** The row's one button, found from the label that says exactly the row's words (`Row`, Parts.tsx). */
const rowButton = `Array.from(document.querySelectorAll('[role="dialog"] div')).find(div => div.innerText === ${JSON.stringify(ROW)})?.parentElement?.parentElement?.querySelector('button')`

/** Notifications every registration of this origin is showing, as plain values. */
const shown = `navigator.serviceWorker.getRegistrations().then(all => Promise.all(all.map(r => r.getNotifications()))).then(lists => lists.flat().map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })))`

/**
 * Grants this origin notifications through Chrome's own permission API, as a Person's Allow does.
 * Chrome keeps such a grant only while the DevTools connection that made it is open, so the
 * connection is handed back and closed when the journey ends.
 */
async function grant(state, run) {
  const address = (await run(['get', 'cdp-url'])).trim().replace(/^"|"$/gu, '')
  const browser = await connect(address)
  await browser.send('Browser.grantPermissions', {
    origin: new URL(state.web).origin,
    permissions: ['notifications'],
  })
  return browser
}

/**
 * Turn notifications on in Settings, see the server hold this browser's subscription, then have
 * Vivid notify the Person from another Thread while the app's tab is in the background, and read
 * the notification the service worker showed.
 */
export async function pushBrowser(state, id, directory, browser) {
  const granted = await grant(state, browser.run)
  try {
    await journey(state, id, directory, browser)
  } finally {
    granted.close()
  }
}

async function journey(state, id, directory, { run, capture }) {
  const before = await rpc(state, 'ListPushTargets', undefined, directory, 'targets-before')
  const browsersBefore = browsersIn(before).length
  await run(['open', state.web + '/t/' + id + '?settings=general'])
  await run(['wait', '--fn', `Boolean(${rowButton})`])
  NodeAssert.equal(
    Result.getOrThrow(decodeLabel(await run(['eval', 'Notification.permission']))),
    'granted',
    'The grant must reach the page before it reads this browser',
  )
  await capture('row-off')
  NodeAssert.equal(
    Result.getOrThrow(decodeLabel(await run(['eval', `${rowButton}.innerText`]))),
    'Turn on',
  )
  // A real press: the browser takes a permission question only inside a user gesture.
  await run(['find', 'role', 'button', 'click', '--name', 'Turn on', '--exact'])
  // The machine reads On once the server has the subscription: the row then offers Turn off.
  await run(['wait', '--fn', `${rowButton}?.innerText === 'Turn off' && !${rowButton}.disabled`])
  await capture('row-on')
  const after = await rpc(state, 'ListPushTargets', undefined, directory, 'targets-after')
  const browsers = browsersIn(after)
  NodeAssert.equal(browsers.length, browsersBefore + 1, 'Expected this browser registered once')
  const endpoint = new URL(browsers.at(-1).destination.endpoint)
  await json(directory + '/endpoint.json', { host: endpoint.host })

  // Reload: the launch reads the held subscription and registers it again as the same target.
  await run(['reload'])
  await run(['wait', '--fn', `${rowButton}?.innerText === 'Turn off' && !${rowButton}.disabled`])
  const reloaded = await rpc(state, 'ListPushTargets', undefined, directory, 'targets-reloaded')
  NodeAssert.deepEqual(
    browsersIn(reloaded).map((t) => t.id),
    browsers.map((t) => t.id),
  )

  // The Person is away: another tab in front, and Vivid works in a Thread this page is not on.
  const app = Result.getOrThrow(decodeTabs(await run(['tab', '--json']))).data.tabs.find(
    (tab) => tab.active,
  )
  NodeAssert.ok(app, 'Missing the app tab')
  await run(['tab', 'new', 'about:blank'])
  const away = crypto.randomUUID()
  await rpc(
    state,
    'CreateThread',
    { id: away, title: 'Verify push away', projectId: null },
    directory,
  )
  await chat(
    state,
    away,
    `Notify me on my devices right now, titled "${TITLE}", saying "${BODY}" Then reply done.`,
    directory,
    'notify',
  )
  await settled(state, away, 1, 'Completed', directory)
  await run(['tab', app.tabId])
  await run([
    'wait',
    '--fn',
    `(async () => (await ${shown}).some(n => n.title === ${JSON.stringify(TITLE)}))()`,
  ])
  const notifications = Result.getOrThrow(decodeShown(await run(['eval', shown])))
  await json(directory + '/notifications.json', notifications)
  const mine = notifications.find((n) => n.title === TITLE)
  NodeAssert.deepEqual(
    mine.data.opens,
    { _tag: 'Thread', threadId: away },
    'The notification opens the Thread it is about',
  )
  await capture('notified')

  // Turning off removes the target and the subscription; a reload stays off.
  await run(['open', state.web + '/t/' + id + '?settings=general'])
  await run(['wait', '--fn', `${rowButton}?.innerText === 'Turn off' && !${rowButton}.disabled`])
  await run(['find', 'role', 'button', 'click', '--name', 'Turn off', '--exact'])
  await run(['wait', '--fn', `${rowButton}?.innerText === 'Turn on' && !${rowButton}.disabled`])
  await run(['reload'])
  await run(['wait', '--fn', `${rowButton}?.innerText === 'Turn on' && !${rowButton}.disabled`])
  const off = await rpc(state, 'ListPushTargets', undefined, directory, 'targets-off')
  NodeAssert.equal(browsersIn(off).length, browsersBefore)
  await capture('row-off-again')
  await json(directory + '/scope.json', {
    proved: [
      'Settings row turns notifications on: permission, subscription against GetPushKey, RegisterPushTarget',
      'A reload registers the held subscription again as the same target',
      'notify_person from a real model Run in another Thread reaches this browser through the push service and the service worker shows it',
      'Turning off removes the target and the subscription; a reload stays off',
    ],
    unproved: [
      'The offer after the first message (needs a never-answered permission and a press)',
      'Pressing the system notification (headless Chrome draws no notification to press)',
      'Phone and desktop delivery',
    ],
  })
}
