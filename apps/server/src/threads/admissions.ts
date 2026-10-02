import { Effect, Semaphore } from 'effect'
import type { ThreadId } from '@vivid/contracts'

/**
 * Serialize only reservation through Flue receipt in this server, never the response itself.
 * Admission marks cannot exclude another pending reservation, so simultaneous requests must
 * recheck under the same permit. Reference counting retains queued users and releases idle keys.
 * The SQL Thread lock still protects turn allocation; no transaction spans runtime I/O.
 */
export const serializeAdmissions = () => {
  const admitting = new Map<ThreadId, { permit: Semaphore.Semaphore; users: number }>()
  return <A, E, R>(effect: Effect.Effect<A, E, R>, id: ThreadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* Effect.acquireRelease(
          Effect.sync(() => {
            let current = admitting.get(id)
            if (current === undefined) {
              current = { permit: Semaphore.makeUnsafe(1), users: 0 }
              admitting.set(id, current)
            }
            current.users += 1
            return current
          }),
          (current) =>
            Effect.sync(() => {
              current.users -= 1
              if (current.users === 0) admitting.delete(id)
            }),
        )
        return yield* lock.permit.withPermit(effect)
      }),
    )
}
