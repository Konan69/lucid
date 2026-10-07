import { Effect, Schema } from 'effect'
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
