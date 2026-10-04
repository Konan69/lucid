import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import { InputStore } from '../inputs/store.ts'
import { observeFailures } from '../observability/failure.ts'
import { ApprovalStore } from './store.ts'

/** The scoped worker uses the store's Clock-based claim; shutdown interrupts only this worker. */
export const approvalSweeperLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const approvals = yield* ApprovalStore
    const inputs = yield* InputStore
    // Each pass's failure is recorded with its tag before the recovery below reduces it to a line.
    const observed = observeFailures('schedule')
    const pass = Effect.all(
      [
        approvals.expire().pipe(
          observed,
          Effect.catch(() => Effect.logError('Approval expiry pass failed')),
        ),
        approvals.replay().pipe(
          observed,
          Effect.catch(() => Effect.logError('Approval replay pass failed')),
        ),
        inputs.replay().pipe(
          observed,
          Effect.catch(() => Effect.logError('Input replay pass failed')),
        ),
      ],
      { discard: true },
    )
    yield* pass.pipe(Effect.repeat(Schedule.spaced('30 seconds')), Effect.forkScoped)
  }),
)
