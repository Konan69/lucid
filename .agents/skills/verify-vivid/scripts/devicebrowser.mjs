import * as NodeAssert from 'node:assert/strict'
import { DeviceAccess } from '@vivid/contracts'
import { enrol, connectedOther, deviceState } from './devices.mjs'
import { rpc, json } from './wire.mjs'

/** Scope DOM assertions to the accessible question section, never hidden source or API text. */
function question(name) {
  return `document.querySelector('article[aria-label="Device request for ${name}"]')`
}

/** Reload must reconstruct the same actionable question from persisted server state. */
async function pendingOn(browser, address, name, stage) {
  const { run, capture } = browser
  await run(['open', address])
  await run(['wait', '--fn', `Boolean(${question(name)})`])
  await capture(stage)
  await run(['reload'])
  await run(['wait', '--fn', `Boolean(${question(name)})`])
  await capture(stage + '-reloaded')
}

/** Use the rendered answer's accessible name, preserving the normal click event and RPC adapter. */
async function choose(run, name, answer) {
  await clickAnswer(run, question(name), answer)
}

/** Actual UI decisions and semantic publications prove Feed and Settings requests, that only
 * the newest Pending computer asks, and that Threads and the empty start screen carry no request.
 * The caller owns browser acquisition, authentication, process receipts and finally cleanup. */
export async function deviceBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  await connectedOther(state, directory, async (other) => {
    // Enrolled first, so it waits longer: a reinstalled app leaves such a row, and it must not ask.
    const older = await enrol(state, directory, 'Older pending computer')
    const { device } = await enrol(state, directory, 'Browser pending computer')
    try {
      const before = await rpc(state, 'ListDevices', undefined, directory, 'before-surfaces')
      NodeAssert.equal(before.devices.find((d) => d.id === other.id).presence._tag, 'Connected')
      await run(['open', state.web + '/t/' + id])
      await run(['wait', '--fn', `Boolean(document.querySelector('textarea'))`])
      NodeAssert.equal(
        JSON.parse(
          await run([
            'eval',
            `Boolean(document.querySelector('article[aria-label^="Device request for "]'))`,
          ]),
        ),
        false,
      )
      await capture('thread-no-request')
      await run(['reload'])
      await run(['wait', '--fn', `Boolean(document.querySelector('textarea'))`])
      NodeAssert.equal(
        JSON.parse(
          await run([
            'eval',
            `Boolean(document.querySelector('article[aria-label^="Device request for "]'))`,
          ]),
        ),
        false,
      )
      await capture('thread-no-request-reloaded')
      await run(['open', state.web + '/'])
      await run(['wait', '--fn', `Boolean(document.querySelector('textarea'))`])
      NodeAssert.equal(JSON.parse(await run(['eval', `Boolean(${question(device.name)})`])), false)
      await capture('home-no-request')
      await pendingOn({ run, capture }, state.web + '/feed', device.name, 'feed')
      NodeAssert.equal(
        JSON.parse(await run(['eval', `Boolean(${question(older.device.name)})`])),
        false,
      )
      await capture('feed-one-ask')
      await run(['open', state.web + '/?settings=devices'])
      await run([
        'wait',
        '--fn',
        `Boolean(document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(device.name)}))`,
      ])
      await capture('settings-pending')
      await run(['reload'])
      await run([
        'wait',
        '--fn',
        `Boolean(document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(device.name)}))`,
      ])
      await capture('settings-pending-reloaded')
      const unchanged = await rpc(state, 'ListDevices', undefined, directory, 'after-reloads')
      NodeAssert.deepEqual(unchanged.devices.find((d) => d.id === device.id).access, device.access)
      await pendingOn({ run, capture }, state.web + '/feed', device.name, 'feed-deny')
      await choose(run, device.name, 'Deny')
      await deviceState(state, directory, 'ui-denied', (list) =>
        list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Revoked(d.access)),
      )
      await run(['wait', '--fn', `!(${question(device.name)})`])
      await capture('feed-denied')
      await settingsDecisions(state, directory, run, capture)
      await feedDecision(state, directory, run, capture)
    } finally {
      await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-pending')
      await rpc(state, 'RevokeDevice', { id: older.device.id }, directory, 'cleanup-older')
    }
  })
  await json(directory + '/scope.json', {
    modelCalls: 0,
    scope:
      'Threads carry no request before or after reload while a device is Pending; Home carries no request; Feed and Settings pending after reload while another device is Connected; only the newest Pending computer asks on Feed; Settings Allow/revoke; Feed Allow and Deny',
    unsupported: [
      'server process restart control',
      'native phone and desktop controls',
      'general Feed delivery and Watch occurrences',
    ],
  })
}

/** Settings uses its own rendered row so another computer's Allow cannot satisfy the proof. */
async function settingsDecisions(state, directory, run, capture) {
  const { device } = await enrol(state, directory, 'Settings computer')
  try {
    await run(['open', state.web + '/?settings=devices'])
    await run(['wait', '--text', device.name])
    await settingsChoice(run, device.name, 'Allow')
    await deviceState(state, directory, 'settings-allowed', (list) =>
      list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Allowed(d.access)),
    )
    await capture('settings-allowed')
    await settingsChoice(run, device.name, 'Stop allowing')
    await deviceState(state, directory, 'settings-revoked', (list) =>
      list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Revoked(d.access)),
    )
    await capture('settings-revoked')
  } finally {
    await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-settings')
  }
}

/** Feed's device question uses the same Person decision while general Feed delivery stays blocked. */
async function feedDecision(state, directory, run, capture) {
  const { device } = await enrol(state, directory, 'Feed computer')
  try {
    await pendingOn({ run, capture }, state.web + '/feed', device.name, 'feed-decision')
    await choose(run, device.name, 'Allow')
    await deviceState(state, directory, 'feed-allowed', (list) =>
      list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Allowed(d.access)),
    )
    await run(['wait', '--fn', `!(${question(device.name)})`])
    await capture('feed-allowed')
  } finally {
    await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-feed')
  }
}

/** Wait for the dialog's own row and action; Home behind it may already contain the same name. */
async function settingsChoice(run, name, answer) {
  const label = `Array.from(document.querySelectorAll('[role="dialog"] div')).find(d => d.textContent === ${JSON.stringify(name)})`
  await run([
    'wait',
    '--fn',
    `(() => { const label = ${label}; return Boolean(label && Array.from(label.parentElement.parentElement.querySelectorAll('button')).some(b => b.innerText.trim() === ${JSON.stringify(answer)})); })()`,
  ])
  const row = `(${label}).parentElement.parentElement`
  await clickAnswer(run, row, answer)
}

/** The CLI supports CSS ordinals. Resolve the exact visible row's action without custom selectors. */
async function clickAnswer(run, container, answer) {
  const target = `Array.from((${container}).querySelectorAll('button')).find(b => b.innerText.trim() === ${JSON.stringify(answer)})`
  const index = JSON.parse(
    await run(['eval', `Array.from(document.querySelectorAll('button')).indexOf(${target})`]),
  )
  NodeAssert.ok(Number.isInteger(index) && index >= 0, 'Missing visible answer ' + answer)
  await run(['find', 'nth', String(index), 'button', 'click'])
}
