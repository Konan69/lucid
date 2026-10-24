import * as NodeAssert from 'node:assert/strict'
import { DeviceAccess } from '@vivid/contracts'
import { enrol, connectedOther, deviceState, askQuestion } from './devices.mjs'
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

/** Actual UI decisions and semantic publications prove Home, Thread, Feed and Settings together.
 * The caller owns browser acquisition, authentication, process receipts and finally cleanup. */
export async function deviceBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  await connectedOther(state, directory, async (other) => {
    const { device } = await enrol(state, directory, 'Browser pending computer')
    try {
      const before = await rpc(state, 'ListDevices', undefined, directory, 'before-surfaces')
      NodeAssert.equal(before.devices.find((d) => d.id === other.id).presence._tag, 'Connected')
      await pendingOn({ run, capture }, state.web + '/', device.name, 'home')
      await pendingOn({ run, capture }, state.web + '/t/' + id, device.name, 'thread')
      await pendingOn({ run, capture }, state.web + '/feed', device.name, 'feed')
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
      const asked = await askQuestion(state, id, directory)
      await run(['open', state.web + '/t/' + id])
      await run(['wait', '--text', asked.questions[0].question])
      await run(['wait', '--fn', `Boolean(${question(device.name)})`])
      await capture('thread-alongside-question')
      await run(['reload'])
      await run(['wait', '--text', asked.questions[0].question])
      await run(['wait', '--fn', `Boolean(${question(device.name)})`])
      await capture('thread-question-reloaded')
      await choose(run, device.name, 'Deny')
      await deviceState(state, directory, 'ui-denied', (list) =>
        list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Revoked(d.access)),
      )
      await run(['wait', '--fn', `!(${question(device.name)})`])
      await run(['wait', '--text', asked.questions[0].question])
      await capture('denied-question-remains')
      const detail = await rpc(state, 'GetThread', { id }, directory, 'question-remains')
      NodeAssert.equal(detail.requests.find((r) => r.id === asked.id).state._tag, 'Waiting')
      await settingsDecisions(state, directory, run, capture)
      await feedDecision(state, directory, run, capture)
    } finally {
      await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-pending')
    }
  })
  await json(directory + '/scope.json', {
    modelCalls: 0,
    questionSource:
      'public AskInput with disposable runtime authority; no model generation claimed',
    scope:
      'Home, Thread and Feed pending after reload while another device is Connected; Settings pending and Allow/revoke; Thread question coexistence and Deny; Feed Allow',
    unsupported: [
      'server process restart control',
      'native phone and desktop controls',
      'Home structured question has no public entry point',
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

/** A Settings row has no ARIA role; match its exact visible label and its own action button. */
async function settingsChoice(run, name, answer) {
  const row = `Array.from(document.querySelectorAll('[role="dialog"] div')).find(d => d.textContent === ${JSON.stringify(name)}).parentElement.parentElement`
  await clickAnswer(run, row, answer)
}

/** The CLI supports CSS ordinals. Resolve the exact visible row's action without custom selectors. */
async function clickAnswer(run, container, answer) {
  const target = `Array.from((${container}).querySelectorAll('button')).find(b => b.innerText.trim() === ${JSON.stringify(answer)})`
  const index = Number(
    await run([
      'eval',
      `JSON.stringify(Array.from(document.querySelectorAll('button')).indexOf(${target}))`,
    ]),
  )
  NodeAssert.ok(Number.isInteger(index) && index >= 0, 'Missing visible answer ' + answer)
  await run(['find', 'nth', String(index), 'button', 'click'])
}
