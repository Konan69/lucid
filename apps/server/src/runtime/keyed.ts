import { Effect, Semaphore } from 'effect'

/**
 * A permit per key, retained by every active or queued caller and removed only at zero users.
 * Derived from Thread admission serialization: time/capacity eviction could replace a permit
 * while callers still wait on it and let two operations for the same key run together.
 * Keep this synchronous owner as a value, rather than a service or scoped RcMap constructor.
 */
export const keyedPermits = <Key>() => {
  const held = new Map<Key, { permit: Semaphore.Semaphore; users: number }>()

  /** Count at execution, before waiting, so queued callers retain the same entry as holders. */
  const enter = (key: Key) =>
    Effect.sync(() => {
      let current = held.get(key)
      if (current === undefined) {
        current = { permit: Semaphore.makeUnsafe(1), users: 0 }
        held.set(key, current)
      }
      current.users += 1
      return current
    })

  /** Only the last queued or active caller may remove an entry; there is no timed eviction. */
  const leave = (key: Key, current: { permit: Semaphore.Semaphore; users: number }) =>
    Effect.sync(() => {
      current.users -= 1
      if (current.users === 0) held.delete(key)
    })

  /** Count before waiting; acquireRelease registers cleanup without an interruption gap (Effect 4.0.2). */
  const lease = (key: Key) =>
    Effect.acquireRelease(enter(key), (current) => leave(key, current)).pipe(
      Effect.map((current) => current.permit),
    )

  /**
   * Return the permit before freeing the key, preserving the wrapped program's ambient scope.
   * A private Effect.scoped around the work would prematurely close resources the caller owns.
   */
  const withPermit = <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      enter(key),
      (current) => current.permit.withPermit(effect),
      (current) => leave(key, current),
    )

  return { lease, withPermit }
}

export type KeyedPermits<Key> = ReturnType<typeof keyedPermits<Key>>
