import type { Context } from '@earendil-works/chord'
import { LiveDoc, type Harness, type ConversationId } from '@earendil-works/pi-durable'
import * as Pi from './pi.ts'
import { waiting } from './waiting.ts'
import type { ConversationMissing, PiFailed } from './errors.ts'
import { Effect, Option, Schema } from 'effect'
import { BusyPolicyInvalid } from './errors.ts'
import type { InputOptions } from './input.ts'

/** Pi submissions.js:129 rejects before admission; :149 defaults queued inputs to followUp. */
export const BusyPolicy = Schema.Literals(['steer', 'followUp', 'reject'])
export type BusyPolicy = typeof BusyPolicy.Type
const decodeBusy = Schema.decodeUnknownEffect(BusyPolicy)

/** Host policy is decoded once, then every internal draft carries an explicit choice. */
export const busyPolicy: (options: InputOptions) => Effect.Effect<BusyPolicy, BusyPolicyInvalid> =
  Effect.fn('Durable.busyPolicy')(function* (options) {
    const value = options.whenBusy === undefined ? 'followUp' : options.whenBusy
    return yield* decodeBusy(value).pipe(Effect.mapError(() => new BusyPolicyInvalid({ value })))
  })

/** Use waiting's durable task decisions, excluding later questions that do not block a run.
 * A generation or running slot is work in flight. Unallocated sequential successors are queued,
 * not work; every allocated pending slot must be a waiting hold before the round is parked.
 * watchEvents lacks hook memo changes, so admission refreshes this read on settled run events. */
export const isParked: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<boolean, ConversationMissing | PiFailed> = Effect.fn('Durable.isParked')(
  function* (harness, conversationId, context) {
    const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
    if (Option.isNone(live) || live.value.run === undefined || live.value.generation !== undefined)
      return false
    const slots = live.value.tools === undefined ? [] : live.value.tools
    if (slots.some((slot) => slot.status === 'running')) return false
    const rows = (yield* waiting(harness, conversationId, context)).filter(
      (row) => row.kind !== 'later',
    )
    const held = new Set(rows.map((row) => row.callId))
    return (
      rows.length > 0 &&
      slots.every(
        (slot) => slot.status !== 'pending' || slot.taskId === undefined || held.has(slot.callId),
      )
    )
  },
)
