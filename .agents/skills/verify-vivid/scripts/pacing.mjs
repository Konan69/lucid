import * as NodeAssert from 'node:assert/strict'
import { Schema } from 'effect'
import { PatchSettingsRequest } from '@vivid/contracts'
import { decodeText } from './receipts.mjs'
import { chat, history, json, rpc, settled } from './wire.mjs'
import { connectPulse, emit, posted } from './watch.mjs'
import { command } from './process.mjs'

/** Read only this Launch's database. Notification rows are the actual server's delivery obligations. */
async function notices(state, thread, directory, name) {
  NodeAssert.match(thread, /^watch-[a-f0-9]+$/u)
  const output = await command([
    'docker',
    'exec',
    state.container,
    'psql',
    '-U',
    'verify',
    '-d',
    'verify',
    '-At',
    '-c',
    `SELECT coalesce(json_agg(row_to_json(n)), '[]'::json) FROM (SELECT kind, title, created_at FROM vivid_notifications WHERE conversation_id='${thread}') n`,
  ])
  const rows = decodeText(
    Schema.Array(
      Schema.Struct({ kind: Schema.String, title: Schema.String, created_at: Schema.Finite }),
    ),
    output,
  )
  await json(directory + '/' + name + '.json', rows)
  return rows
}

/** Use the production pacer and SQL queue over this run's real posts/settings. Only its clock is
 * controlled, after SQL resources acquire with live time. This proves pacing without waiting
 * thirty minutes for quiet. No model, memory, post, notification or delivery service is mocked.
 * No browser is opened during this recipe, so the real Presence service has no holds. */
async function pass(state, at, directory, name) {
  NodeAssert.equal(state.container, 'vivid-verify-' + state.run)
  await command(['pnpm', '--filter', '@vivid/server', 'exec', 'tsx', 'tests/pacing/main.ts'], {
    env: {
      ...process.env,
      VIVID_TEST_DATABASE_URL: `postgres://verify:verify@127.0.0.1:${state.ports.database}/verify`,
      VIVID_VERIFY_PACING_AT: String(at),
    },
    log: directory + '/' + name + '-pass.json',
  })
  await json(directory + '/' + name + '-clock.json', {
    at,
    iso: new Date(at).toISOString(),
    controlled: true,
  })
}

/** One spoken preference, then real-model background posts through the disposable Integration.
 * Choose a real IANA zone currently before eleven, so the actual urgent post also happens outside
 * the window. Future clock passes check ten/eleven after every foreground Run is quiet. */
export async function pacing(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Spoken pacing requires a real model')
  const now = Date.now()
  const hour = (zone) =>
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(now),
    )
  const zone = Intl.supportedValuesOf('timeZone').find(
    (candidate) => hour(candidate) >= 8 && hour(candidate) < 10,
  )
  NodeAssert.ok(zone, 'No IANA zone currently before eleven')
  await rpc(
    state,
    'PatchSettings',
    PatchSettingsRequest.make({ timezone: zone }),
    directory,
    'timezone',
  )
  await chat(state, id, "Don't message me before 11 in the morning.", directory)
  await settled(state, id, 1, 'Completed', directory)
  const saved = await rpc(state, 'GetSettings', undefined, directory, 'spoken-hours')
  NodeAssert.deepEqual(saved.wakingHours, { start: 660, end: 1290 })
  const page = await history(state, id, directory)
  NodeAssert.ok(
    page.messages
      .flatMap((message) => message.parts)
      .some(
        (part) =>
          part.type === 'dynamic-tool' &&
          part.toolName === 'set_waking_hours' &&
          part.state === 'output-available',
      ),
    'The real model did not save contact hours',
  )
  const integration = await connectPulse(state, directory)
  const marker = 'Pacing ' + crypto.randomUUID().slice(0, 8)
  await chat(
    state,
    id,
    `Watch my Verify Pulse Integration for pulse.received events. Name the Watch ${marker}. When an event arrives, put its update on my Feed with the title ${marker} followed by the event receipt. Routine progress updates are ordinary; a compromised account requiring me to revoke access immediately is urgent. Keep watching until I stop it.`,
    directory,
  )
  await settled(state, id, 2, 'Completed', directory)
  const watches = await rpc(state, 'ListWatches', undefined, directory)
  const watch = watches.watches.find((candidate) => candidate.name === marker)
  NodeAssert.ok(watch, 'Model did not create the Watch')
  try {
    const receipt = await emit(
      state,
      {
        app: integration.app,
        words: 'Routine progress update: the weekly report is ready for whenever you have time.',
        name: 'ordinary-event',
      },
      directory,
    )
    const ordinary = await posted(state, marker + ' ' + receipt, directory)
    await settled(state, ordinary.thread, 1, 'Completed', directory)
    const ordinaryHistory = await history(state, ordinary.thread, directory)
    NodeAssert.ok(
      ordinaryHistory.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === 'dynamic-tool' &&
            part.toolName === 'post' &&
            part.input.urgency === 'ordinary',
        ),
    )
    // Tomorrow at local 10, derived from the selected zone's current local hour/minute.
    const minutes = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, minute: 'numeric' }).format(now),
    )
    const ten = now - (hour(zone) * 60 + minutes) * 60_000 + (24 + 10) * 3_600_000
    await pass(state, ten, directory, 'outside')
    NodeAssert.equal(
      (await notices(state, ordinary.thread, directory, 'outside-notices')).length,
      0,
    )
    const urgentReceipt = await emit(
      state,
      {
        app: integration.app,
        words:
          'Security alert: your account is compromised and an attacker has access now. Revoke the stolen access immediately.',
        name: 'urgent-event',
      },
      directory,
    )
    const urgent = await posted(state, marker + ' ' + urgentReceipt, directory)
    await settled(state, urgent.thread, 1, 'Completed', directory)
    const urgentHistory = await history(state, urgent.thread, directory)
    NodeAssert.ok(
      urgentHistory.messages
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === 'dynamic-tool' &&
            part.toolName === 'post' &&
            part.input.urgency === 'urgent',
        ),
    )
    const urgentNotices = await notices(state, urgent.thread, directory, 'urgent-outside-notices')
    NodeAssert.equal(urgentNotices.length, 1)
    NodeAssert.equal(urgentNotices[0].kind, 'needs-you')
    await pass(state, ten + 3_600_000, directory, 'inside')
    const ordinaryNotices = await notices(state, ordinary.thread, directory, 'inside-notices')
    NodeAssert.equal(ordinaryNotices.length, 1)
    NodeAssert.equal(ordinaryNotices[0].kind, 'posted')
    await pass(state, ten + 3_600_000, directory, 'repeat')
    NodeAssert.equal((await notices(state, ordinary.thread, directory, 'repeat-notices')).length, 1)
    await json(directory + '/scope.json', {
      zone,
      saved: saved.wakingHours,
      ordinary: ordinary.thread,
      urgent: urgent.thread,
      scope:
        'Real model spoken correction and Watch posts; production pacer with controlled clock and real disposable SQL/queue. Notification obligations, not device push delivery.',
    })
  } finally {
    await rpc(state, 'StopWatch', { id: watch.id }, directory, 'stop-pacing-watch')
  }
}
