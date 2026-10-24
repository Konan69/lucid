import * as NodeAssert from 'node:assert/strict'
import { DeviceAccess } from '@vivid/contracts'
import { enrol, connectedOther, deviceState, askQuestion } from './devices.mjs'
import { rpc, json } from './wire.mjs'

/** Scope DOM assertions to the accessible question section, never hidden source or API text. */
function question(name) {
  return `document.querySelector('article[aria-label="Device request for ${name}"]')`
}

/** Reload must reconstruct the same actionable Feed card from persisted server state. */
async function pendingOn(browser, surface) {
  const { address, name, stage } = surface
  await browser.run(['open', address])
  await browser.run(['wait', '--fn', `Boolean(${question(name)})`])
  await browser.capture(stage)
  await browser.run(['reload'])
  await browser.run(['wait', '--fn', `Boolean(${question(name)})`])
  await browser.capture(stage + '-reloaded')
}

/** A ready conversation must never acquire device controls, including after a fresh page load. */
async function absentOn(browser, surface) {
  await browser.run(['open', surface.address])
  await absent(browser, surface)
  await browser.run(['reload'])
  await absent(browser, { ...surface, stage: surface.stage + '-reloaded' })
}

/** Assert absence only after the intended screen is ready, and retain the evaluated DOM result. */
async function absent(browser, surface) {
  await browser.run(surface.ready)
  const missing = JSON.parse(
    await browser.run([
      'eval',
      `document.querySelectorAll('article[aria-label^="Device request for "]').length === 0`,
    ]),
  )
  NodeAssert.equal(missing, true, 'Device request leaked into ' + surface.stage)
  await browser.capture(surface.stage)
}

/** Thread identity and Waiting state come from public contracts, never from copied question text. */
async function waitingQuestion(state, context, directory, browser) {
  const { id, asked, stage } = context
  await absentOn(browser, {
    address: state.web + '/t/' + id,
    ready: ['wait', '--text', asked.questions[0].question],
    stage,
  })
  const detail = await rpc(state, 'GetThread', { id }, directory, stage)
  NodeAssert.equal(detail.thread.id, id)
  NodeAssert.equal(detail.requests.find((r) => r.id === asked.id).state._tag, 'Waiting')
  NodeAssert.equal(detail.runs.length, 0, 'Device decisions must not start model work')
}

/** Feed and Settings own decisions. Home and Thread remain free of device requests.
 * The caller owns browser authentication, process receipts and finally cleanup. */
export async function deviceBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  await connectedOther(state, directory, async (other) => {
    const { device } = await enrol(state, directory, 'Browser pending computer')
    try {
      const asked = await askQuestion(state, id, directory)
      await pendingOn(browser, { address: state.web + '/feed', name: device.name, stage: 'feed' })
      await absentOn(browser, {
        address: state.web + '/',
        ready: ['wait', '[aria-label="Message Vivid"]'],
        stage: 'home',
      })
      await waitingQuestion(state, { id, asked, stage: 'thread-question' }, directory, browser)
      await pendingOn(browser, {
        address: state.web + '/feed',
        name: device.name,
        stage: 'feed-return',
      })
      const unchanged = await rpc(state, 'ListDevices', undefined, directory, 'after-reloads')
      NodeAssert.deepEqual(unchanged.devices.find((d) => d.id === device.id).access, device.access)
      NodeAssert.equal(unchanged.devices.find((d) => d.id === other.id).presence._tag, 'Connected')
      await run(['open', state.web + '/?settings=devices'])
      await settingsChoiceReady(run, device.name, 'Deny')
      await capture('settings-pending')
      await run(['reload'])
      await settingsChoiceReady(run, device.name, 'Deny')
      await capture('settings-pending-reloaded')
      await pendingOn(browser, {
        address: state.web + '/feed',
        name: device.name,
        stage: 'feed-after-settings',
      })
      await clickAnswer(run, question(device.name), 'Deny')
      await deviceState(state, directory, 'ui-denied', (list) =>
        list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Revoked(d.access)),
      )
      await run(['wait', '--fn', `!(${question(device.name)})`])
      await capture('feed-denied')
      await waitingQuestion(state, { id, asked, stage: 'question-after-deny' }, directory, browser)
      await settingsDecisions(state, directory, run, capture)
      await waitingQuestion(
        state,
        { id, asked, stage: 'question-after-settings' },
        directory,
        browser,
      )
      await feedDecision(state, directory, run, capture)
      await waitingQuestion(state, { id, asked, stage: 'question-after-allow' }, directory, browser)
    } finally {
      await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-pending')
    }
  })
  await json(directory + '/scope.json', {
    modelCalls: 0,
    questionSource:
      'public AskInput with disposable runtime authority; no model generation claimed',
    scope:
      'Pending persists on Feed after reload and navigation while another device is Connected; no request on Home or Thread; Settings pending, Allow and revoke; Feed Deny and Allow; unrelated Thread question remains Waiting throughout',
    unsupported: [
      'server process restart control',
      'native phone and desktop controls require their separate journeys',
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
    await pendingOn(
      { run, capture },
      { address: state.web + '/feed', name: device.name, stage: 'feed-decision' },
    )
    await clickAnswer(run, question(device.name), 'Allow')
    await deviceState(state, directory, 'feed-allowed', (list) =>
      list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Allowed(d.access)),
    )
    await run(['wait', '--fn', `!(${question(device.name)})`])
    await capture('feed-allowed')
  } finally {
    await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-feed')
  }
}

/** Scope readiness to this Settings row so another computer cannot satisfy the decision check. */
async function settingsChoiceReady(run, name, answer) {
  const label = `Array.from(document.querySelectorAll('[role="dialog"] div')).find(d => d.textContent === ${JSON.stringify(name)})`
  await run([
    'wait',
    '--fn',
    `(() => { const label = ${label}; return Boolean(label && Array.from(label.parentElement.parentElement.querySelectorAll('button')).some(b => b.innerText.trim() === ${JSON.stringify(answer)})); })()`,
  ])
  return `(${label}).parentElement.parentElement`
}

/** Wait for this computer's own row before sending its normal UI decision. */
async function settingsChoice(run, name, answer) {
  const row = await settingsChoiceReady(run, name, answer)
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
