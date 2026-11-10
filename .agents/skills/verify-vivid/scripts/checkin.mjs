import { Option, Schema } from 'effect'
import * as NodeAssert from 'node:assert/strict'
import {
  BackgroundWork,
  CheckinArming,
  WatchPurpose,
  RunOrigin,
  TimerReceipt,
  OwedState,
} from '@vivid/contracts'
import { observe } from './observation.mjs'
import { chat, history, rpc, settled, json } from './wire.mjs'

const readReceipt = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(true), output: TimerReceipt }),
)

/** Find the provider receipt in the actual runtime tool result, never in the model's prose. */
function timerReceipt(page, operationKey) {
  const calls = page.messages
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === 'dynamic-tool' &&
        part.toolName === 'use_tool' &&
        part.state === 'output-available',
    )
  const found = calls
    .map((part) => readReceipt(part.output))
    .find((value) => Option.exists(value, ({ output }) => output.operationKey === operationKey))
  NodeAssert.ok(
    found && Option.isSome(found),
    'No actual timer receipt for the persisted operation key',
  )
  return found.value.output
}

/** A real requested clock time is confirmed, then changed to a short timer and allowed to fire itself. */
export async function checkin(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Check-ins require a real model')
  const marker = 'Check ' + crypto.randomUUID().slice(0, 8)
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + 86_400_000))
  const expected = Date.parse(date + 'T09:00:00+01:00')
  await chat(
    state,
    id,
    `Ada owes me the ${marker} report. Keep track of it and check on this tomorrow at 9. My time zone is Africa/Lagos. Name the check-in ${marker}. When the check happens, read what is still open and post what you found to my Feed with title ${marker}. This is one check, not a daily recurrence.`,
    directory,
  )
  await settled(state, id, 1, 'Completed', directory)
  const watches = await rpc(state, 'ListWatches', undefined, directory)
  const watching = watches.watches.find((watch) => watch.name === marker)
  NodeAssert.ok(watching && WatchPurpose.guards.Checkin(watching.purpose))
  NodeAssert.ok(
    CheckinArming.guards.Confirmed(watching.purpose.arming),
    'Subscription alone is not an armed check-in',
  )
  // The open work a check-in reads is this Thread's owed records (`ListOwed`); contracts carry no
  // link from a record to the check-in that will read it, so the recipe checks the record exists.
  const inventory = await rpc(state, 'ListOwed', undefined, directory)
  const source = inventory.owed.find(
    (owed) => owed.threadId === id && OwedState.guards.Open(owed.state),
  )
  NodeAssert.ok(source, 'The timer must cover an explicit owed record in this Thread')
  await json(directory + '/open-work.json', inventory)
  NodeAssert.equal(watching.purpose.arming.nextAt, expected)
  const first = timerReceipt(
    await history(state, id, directory),
    watching.purpose.arming.operationKey,
  )
  NodeAssert.equal(first.nextAt, expected)
  await json(directory + '/clock-time-receipt.json', { watch: watching, receipt: first })

  const ready = Promise.withResolvers()
  const confirmation = observe(state, {
    tag: 'WatchWork',
    payload: null,
    accept: (list) => {
      ready.resolve()
      return list.work.some(
        (watch) =>
          BackgroundWork.guards.Watch(watch) &&
          watch.watch === watching.id &&
          WatchPurpose.guards.Checkin(watch.purpose) &&
          CheckinArming.guards.Confirmed(watch.purpose.arming) &&
          watch.purpose.arming.operationKey !== first.operationKey,
      )
    },
  })
  await ready.promise
  await chat(
    state,
    id,
    `For this proof, change ${marker} to check in one second instead, using the timer Integration's shortest positive delay. Keep its source and Feed instruction. Use the same Integration. It should fire on its own; do not call its emitting operation yourself.`,
    directory,
  )
  const confirmed = (await confirmation).work.find(
    (watch) => BackgroundWork.guards.Watch(watch) && watch.watch === watching.id,
  )
  NodeAssert.ok(confirmed && WatchPurpose.guards.Checkin(confirmed.purpose))
  const armed = confirmed.purpose.arming
  NodeAssert.ok(CheckinArming.guards.Confirmed(armed))
  await settled(state, id, 2, 'Completed', directory)
  const receipt = timerReceipt(await history(state, id, directory), armed.operationKey)
  NodeAssert.equal(receipt.nextAt, armed.nextAt)
  const feed = await observe(state, {
    tag: 'WatchFeed',
    payload: null,
    accept: (value) =>
      value.items.some(
        (item) =>
          item.thread.startsWith('watch-') && item.post !== null && item.post.title === marker,
      ),
  })
  const item = feed.items.find(
    (item) => item.thread.startsWith('watch-') && item.post !== null && item.post.title === marker,
  )
  NodeAssert.ok(item)
  const detail = await settled(state, item.thread, 1, 'Completed', directory)
  NodeAssert.equal(detail.runs.length, 1)
  const run = detail.runs[0]
  NodeAssert.ok(RunOrigin.guards.Checkin(run.origin))
  NodeAssert.equal(run.origin.watchId, watching.id)
  const firing = await history(state, item.thread, directory, 'firing-history')
  NodeAssert.ok(
    firing.messages
      .flatMap((message) => message.parts)
      .some(
        (part) =>
          part.type === 'dynamic-tool' &&
          part.toolName === 'list_open_work' &&
          part.state === 'output-available',
      ),
  )
  await json(directory + '/proof.json', {
    watch: watching.id,
    receipt,
    run,
    feed: item,
    firstReceipt: first,
  })
}
