import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import { ApprovalStore } from './store.ts'

/** The scoped worker uses the store's Clock-based claim; shutdown interrupts only this worker. */
export const approvalSweeperLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const approvals = yield* ApprovalStore
    yield* approvals.expire().pipe(
      Effect.catch(() => Effect.logError('Approval expiry pass failed')),
      Effect.repeat(Schedule.spaced('1 minute')),
      Effect.forkScoped,
    )
  }),
)
