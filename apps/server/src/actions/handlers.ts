import * as Effect from 'effect/Effect'
import type { ReconcileActionRequest } from '@vivid/contracts'
import { requirePerson } from '../auth/access.ts'
import { reconcile } from './journal.ts'

export const actionHandlers = {
  /** A signed-in Person who can see the Thread asks; the check is read-only and sends nothing. */
  ReconcileAction: Effect.fn('Rpc.ReconcileAction')(function* ({
    operationId,
  }: ReconcileActionRequest) {
    const auth = yield* requirePerson()
    return yield* reconcile(auth.person.id, operationId)
  }),
}
