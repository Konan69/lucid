import * as Effect from 'effect/Effect'
import { requireActor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { loadAudit } from './store.ts'

export const auditHandlers = {
  /** The one-shot and live views share the same access-scoped loader. */
  ListAudit: Effect.fn('Rpc.ListAudit')(function* () {
    return yield* loadAudit(yield* requireActor())
  }),
  WatchAudit: () => live('WatchAudit', [], loadAudit),
}
