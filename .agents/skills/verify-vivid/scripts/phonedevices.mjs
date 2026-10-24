import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { DeviceAccess, DevicePresence } from '@vivid/contracts'
import { enrol, connectedOther, deviceState } from './devices.mjs'
import { enter, target } from './phoneentry.mjs'
import { rpc, json } from './wire.mjs'

/** Full trees retain noninteractive cards and headings; interactive trees grant press refs only. */
async function capture(run, directory, stage) {
  const snapshot = await run(['snapshot'])
  await NodeFSP.writeFile(directory + '/' + stage + '.aria.txt', snapshot)
  await run(['screenshot', directory + '/' + stage + '.png'])
  return snapshot
}

/** Drawer choices use the same ref acquisition and settled press as the existing Thread recipe. */
async function openPage(run, label) {
  await run(['press', await target(run, 'Open menu')])
  await run(['press', await target(run, label), '--settle'])
}

/** WatchDevices proves the exact Pending grant survives navigation with the other stream alive. */
async function unchanged(state, context, directory) {
  const { device, other, stage } = context
  const list = await deviceState(
    state,
    directory,
    stage,
    (value) =>
      value.devices.some((d) => d.id === device.id && DeviceAccess.guards.Pending(d.access)) &&
      value.devices.some((d) => d.id === other.id && DevicePresence.guards.Connected(d.presence)),
  )
  NodeAssert.deepEqual(list.devices.find((d) => d.id === device.id).access, device.access)
}

/** The exact public device question, rather than a greeting, establishes the loaded Feed query. */
async function pendingFeed(run, directory, context) {
  await run(['wait', 'text', `Let Vivid use ${context.device.name}?`, '60000'])
  const snapshot = await capture(run, directory, context.stage)
  NodeAssert.ok(snapshot.includes(context.device.name), 'Feed must render the pending computer')
  NodeAssert.ok(!snapshot.includes('"Close menu"'), 'Feed must not remain behind the drawer')
}

/** Home and Chat must not render a device request even while the same public grant stays Pending. */
async function absent(run, directory, context) {
  await run(['wait', 'text', 'Message Vivid', '60000'])
  const snapshot = await capture(run, directory, context.stage)
  NodeAssert.ok(!snapshot.includes('"Close menu"'), 'The selected screen must be in front')
  NodeAssert.ok(!snapshot.includes(`Device request for ${context.device.name}`))
  NodeAssert.ok(!snapshot.includes(`Let Vivid use ${context.device.name}?`))
}

/** Presence is held only by the visible Thread (Chat.tsx Present and data/live.ts presentIn).
 * This public receipt rejects a drawer press that left the greeting or another Thread on top. */
async function idleThread(state, context, directory) {
  const detail = await rpc(state, 'GetThread', { id: context.id }, directory, context.stage)
  NodeAssert.equal(detail.thread.id, context.id)
  NodeAssert.equal(detail.runs.length, 0, 'Device navigation must not start model work')
  NodeAssert.ok(detail.present.some((seen) => seen.person.id === context.person))
}

/** Native snapshots and a public decision receipt cover the shipped Feed and Settings adapters.
 * The phone runner owns the APK, lease, session, emulator and finally cleanup around this journey. */
export async function phoneDevices(state, run, directory) {
  const id = crypto.randomUUID()
  const title = 'Phone devices ' + state.run.slice(-8)
  // A nonempty Thread list prevents Home's OpenFirstThread arrival from starting model work.
  await rpc(state, 'CreateThread', { id, title, projectId: null }, directory, 'create-thread')
  await run(['open', 'work.vivid.mobile', '--relaunch'])
  const account = await enter(state, run)
  return connectedOther(state, directory, async (other) => {
    const { device } = await enrol(state, directory, 'Phone pending computer')
    try {
      await openPage(run, 'Feed')
      await pendingFeed(run, directory, { device, stage: 'feed-pending' })
      await unchanged(state, { device, other, stage: 'feed-pending' }, directory)
      // Relaunch retains app data and rebuilds the saved Feed route (data/place.ts and App.tsx).
      await run(['open', 'work.vivid.mobile', '--relaunch'])
      await pendingFeed(run, directory, { device, stage: 'feed-reloaded' })
      await unchanged(state, { device, other, stage: 'feed-reloaded' }, directory)
      await openPage(run, 'New thread')
      await absent(run, directory, { device, stage: 'home-pending-absent' })
      await unchanged(state, { device, other, stage: 'after-home' }, directory)
      await openPage(run, title)
      await absent(run, directory, { device, stage: 'thread-pending-absent' })
      await idleThread(state, { id, person: account.person, stage: 'selected-thread' }, directory)
      await unchanged(state, { device, other, stage: 'after-thread' }, directory)
      await openPage(run, 'Feed')
      await pendingFeed(run, directory, { device, stage: 'feed-returned' })
      await unchanged(state, { device, other, stage: 'feed-returned' }, directory)
      await settingsDecision(state, run, directory, device)
      await openPage(run, 'Feed')
      // Settings has observed the decision in this session's shared device query before return.
      await run(['wait', 'text', 'Message Vivid', '60000'])
      const resolved = await capture(run, directory, 'feed-resolved')
      NodeAssert.ok(!resolved.includes(`Let Vivid use ${device.name}?`))
      await openPage(run, title)
      await absent(run, directory, { device, stage: 'thread-after-decision' })
      await idleThread(
        state,
        { id, person: account.person, stage: 'idle-after-decision' },
        directory,
      )
      await json(directory + '/devices-scope.json', {
        modelCalls: 0,
        scope:
          'Android Feed Pending after relaunch and return while another computer is Connected; absent Home and Chat; native Settings Deny confirmed by WatchDevices; idle Thread identity and zero Runs',
        unsupported: [
          'iOS header clearance requires an iPhone or macOS runner',
          'server process restart and elapsed expiry',
        ],
      })
      return { id, title, device: device.id }
    } finally {
      await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'cleanup-pending')
    }
  })
}

/** There is one Pending computer in this synthetic account, so only its row can offer Deny.
 * Settings' other rows offer Allow or Stop allowing (screen/settings/Devices.tsx Computer). */
async function settingsDecision(state, run, directory, device) {
  await openPage(run, 'Settings')
  await run(['press', await target(run, 'Your computers'), '--settle'])
  await run(['wait', 'text', device.name, '60000'])
  await run(['wait', 'text', 'Waiting for your decision.', '60000'])
  await capture(run, directory, 'settings-pending')
  await run(['press', await target(run, 'Deny'), '--settle'])
  await deviceState(state, directory, 'settings-denied', (list) =>
    list.devices.some((d) => d.id === device.id && DeviceAccess.guards.Revoked(d.access)),
  )
  await run(['wait', 'text', 'Not allowed.', '60000'])
  await capture(run, directory, 'settings-denied')
  await run(['press', await target(run, 'Close'), '--settle'])
}
