import * as NodeAssert from 'node:assert/strict'
import { ComputerHealth, ConnectionGrant, ConnectionState, ScopeEvidence } from '@vivid/contracts'
import { Result, Schema } from 'effect'
import { history, json, rpc, settled } from './wire.mjs'

const decodeText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String))

/** Reads one string from the page, through the owned browser. */
async function text(run, expression) {
  const serialized = Result.getOrThrow(
    decodeText(await run(['eval', 'JSON.stringify(' + expression + ')'])),
  )
  return Result.getOrThrow(decodeText(serialized))
}

/** What the Access panel says for a grant (`grantedOf` in packages/client/state/src/access.ts). */
const grantSummary = (grant) =>
  ConnectionGrant.match(grant, {
    Unverified: () => 'Not checked yet',
    NotRequired: () => 'Needs no sign-in',
    Pending: () => 'Nothing yet: sign-in not finished',
    Granted: ({ scopes }) =>
      ScopeEvidence.guards.Known(scopes)
        ? 'Everything Vivid asked for'
        : 'Allowed, though the service does not say exactly what',
    Partial: () => 'Some of what Vivid asked for',
    Expired: () => 'Nothing now: the sign-in expired',
    Revoked: () => 'Nothing now: access was taken away',
    ReauthorizationRequired: () => 'Nothing until you sign in again',
  })

/** The card of the one Verify Pulse account, by its service heading in the Settings dialog. */
const pulseCard = `Array.from(document.querySelectorAll('[role="dialog"] li')).find(li => li.querySelector('h4')?.innerText.trim() === 'Verify Pulse')`

/**
 * Connects Verify Pulse from Settings with the key typed in its own card: the inline form must
 * be the only form, and Settings the only dialog, so a key dialog over Settings fails the step.
 */
async function connectInline(state, directory, { run, capture }) {
  await run(['open', state.web + '/?settings=connections'])
  await run(['wait', '[aria-label="Search integrations"]'])
  await run(['find', 'label', 'Search integrations', 'fill', 'Verify Pulse'])
  await run(['wait', '[aria-label="Connect Verify Pulse"]'])
  await run(['find', 'role', 'button', 'click', '--name', 'Connect Verify Pulse', '--exact'])
  await run(['wait', 'form[aria-label="Key for Verify Pulse"] input[name=code]'])
  const dialogs = await text(run, `String(document.querySelectorAll('[role="dialog"]').length)`)
  NodeAssert.equal(dialogs, '1', 'The key is typed in the card, not a dialog over Settings')
  await capture('key-in-card')
  await run([
    'fill',
    'form[aria-label="Key for Verify Pulse"] input[name=code]',
    'verify-pulse-local',
  ])
  await run(['find', 'role', 'button', 'click', '--name', 'Connect', '--exact'])
  await run(['wait', '--fn', `!document.querySelector('form[aria-label="Key for Verify Pulse"]')`])
  const list = await rpc(state, 'ListConnections', undefined, directory, 'connected')
  const connection = list.connections.find(
    (candidate) =>
      candidate.service === 'verify-pulse' && ConnectionState.guards.Ready(candidate.state),
  )
  NodeAssert.ok(connection, 'The in-card key did not make a ready Integration')
  return connection
}

/** Opens the account's access under its row and checks it says what the server granted. */
async function accessShown(run, capture, connection, stage) {
  await run(['find', 'label', 'Search integrations', 'fill', 'Verify Pulse'])
  await run(['wait', '--fn', `Boolean(${pulseCard})`])
  await run([
    'find',
    'role',
    'button',
    'click',
    '--name',
    `Show what ${connection.account} can reach`,
    '--exact',
  ])
  await run(['wait', '--fn', `${pulseCard}?.innerText.includes('What it was given')`])
  const shown = await text(run, `${pulseCard}.innerText`)
  NodeAssert.ok(
    shown.includes(grantSummary(connection.grant)),
    'Access panel does not say the server grant',
  )
  await capture(stage)
  return shown
}

/**
 * Settings: Verify Pulse connected with the key typed in its card, its access panel saying the
 * grant the server holds, before and after reload. Thread: a real model's direct read, whose
 * delivered coverage is Partial (output clipped), says so quietly under the reply, before and
 * after reload. The Integration is removed in finally.
 */
export async function integrationsBrowser(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'The coverage line needs a real model read')
  const { run, capture } = browser
  const connection = await connectInline(state, directory, browser)
  try {
    const before = await accessShown(run, capture, connection, 'access')
    await run(['reload'])
    await run(['wait', '[aria-label="Search integrations"]'])
    const after = await accessShown(run, capture, connection, 'access-reloaded')
    await run(['open', state.web + '/t/' + id])
    await run(['wait', '[aria-label="Message Vivid"]'])
    await run([
      'find',
      'label',
      'Message Vivid',
      'fill',
      'Read the sample records in my Verify Pulse Integration directly, without a program or display. Tell me how many records you actually received and whether you have the whole result. Do not infer unseen records.',
    ])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    await settled(state, id, 1, 'Completed', directory)
    const page = await history(state, id, directory, 'settled-history')
    const read = page.messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === 'dynamic-tool' && part.toolName === 'use_tool')
    NodeAssert.ok(read, 'The real model did not read the Integration directly')
    const line = `Array.from(document.querySelectorAll('p')).find(p => p.innerText.includes('only part of it reached Vivid') && p.innerText.includes('as of'))`
    const lines = []
    for (const stage of ['coverage', 'coverage-reloaded']) {
      if (stage === 'coverage-reloaded') await run(['reload'])
      await run(['wait', '--fn', `Boolean(${line})`])
      lines.push(await text(run, `${line}.innerText`))
      await capture(stage)
    }
    NodeAssert.equal(lines[0], lines[1], 'The coverage line changed across reload')
    NodeAssert.ok(lines[0].includes(connection.account), 'The coverage line names the account')
    await json(directory + '/access.json', { grant: connection.grant, before, after, lines })
    await json(directory + '/scope.json', {
      proved: [
        'Key typed inside the Integration card; Settings is the only dialog',
        'Access panel says the grant the server holds, before and after reload',
        'Partial delivered coverage said under the reply with its account and time, before and after reload',
      ],
      blocked: [
        'Data-class switches and the PermissionDeclined card need a disposable Google account (Verify Pulse has no data classes)',
        'ScopeRequired card: the server produces no ScopeRequired outcome yet',
        'Phone and desktop native journeys need their own clients',
      ],
    })
  } finally {
    await rpc(state, 'RemoveConnection', { id: connection.id }, directory, 'removed')
  }
}

/** The title the panel gives each health reading (`healthReading` in client state health.ts). */
const healthTitle = (health) =>
  ComputerHealth.match(health, {
    Absent: () => 'Not made yet',
    Sleeping: () => 'Asleep',
    Starting: () => 'Waking up',
    Held: () => 'You have control',
    Ready: () => 'Ready',
    Degraded: () => 'Not working right',
    Unavailable: () => 'Out of reach',
  })

/** The recovery ladder, as the panel lists it (`LADDER` and `STEP_WORDS`). */
const LADDER = [
  'Wake it',
  'Reconnect to it',
  'Restart its browser',
  'Restart its screen control',
  'Restart the whole computer',
]

/** The Vivid's computer section of Settings, by its heading. */
const panel = `Array.from(document.querySelectorAll('[role="dialog"] section')).find(section => section.querySelector('h3')?.innerText.trim() === 'Vivid’s computer')`

/**
 * Settings, Devices: the Vivid's computer panel says the health the server reports for this run's
 * synthetic Person, lists the recovery ladder with no button to take a step, and says the same
 * after Check again and after reload. It reads health only; it never wakes or makes a Computer.
 */
export async function computerBrowser(state, id, directory, { run, capture }) {
  const health = await rpc(state, 'GetComputerHealth', { depth: 'Deep' }, directory, 'health')
  const title = healthTitle(health)
  await run(['open', state.web + '/t/' + id + '?settings=devices'])
  const readings = []
  for (const stage of ['computer', 'computer-checked', 'computer-reloaded']) {
    if (stage === 'computer-checked')
      await run(['find', 'role', 'button', 'click', '--name', 'Check again', '--exact'])
    if (stage === 'computer-reloaded') await run(['reload'])
    await run(['wait', '--fn', `${panel}?.innerText.includes(${JSON.stringify(title)})`])
    const shown = await text(run, `${panel}.innerText`)
    for (const step of LADDER) NodeAssert.ok(shown.includes(step), 'Ladder lacks ' + step)
    const steps = await text(
      run,
      `String(Array.from(${panel}.querySelectorAll('button')).filter(b => ${JSON.stringify(LADDER)}.some(step => b.innerText.includes(step))).length)`,
    )
    NodeAssert.equal(steps, '0', 'Recovery steps are Vivid’s alone and are never offered')
    readings.push(shown)
    await capture(stage)
  }
  const after = await rpc(state, 'GetComputerHealth', { depth: 'Shallow' }, directory, 'after')
  NodeAssert.equal(after._tag, health._tag, 'Reading the panel changed the Computer')
  await json(directory + '/computer-panel.json', { health, title, readings })
  await json(directory + '/scope.json', {
    proved: [
      'Panel title from the server health, before, after Check again and after reload',
      'Recovery ladder 0 to 4 shown with no step offered to the Person',
      'Reading the panel neither wakes nor makes a Computer',
    ],
    blocked: [
      'Ready, Degraded and the ability list need a proof-owned Computer (Boat trial plan at its two-machine limit)',
      'A settled recovery line needs a recovery step on a proof-owned Computer',
      'Phone Computer screen needs its own client',
    ],
  })
}
