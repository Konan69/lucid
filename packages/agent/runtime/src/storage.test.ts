import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Pool } from 'pg'
import { flueStorage } from './storage.ts'

/** pg connects lazily: an unused real pool proves shutdown without any database authority or I/O. */
const pool = Effect.acquireRelease(
  Effect.sync(() => new Pool()),
  (value) => (value.ended ? Effect.void : Effect.tryPromise(() => value.end()).pipe(Effect.ignore)),
)

describe('Flue storage shutdown', () => {
  it.effect('ends the real pool after Notes cleanup defects and preserves the rejection', () =>
    Effect.gen(function* () {
      const value = yield* pool
      const defect = new Error('Test-controlled Notes cleanup defect')
      // Notes must run while the pool is still live, even when its finalization defects.
      const closing = Effect.fn('StorageTest.close')(function* () {
        expect(value.ended).toBe(false)
        return yield* Effect.die(defect)
      })
      const storage = flueStorage(value, closing())
      yield* Effect.tryPromise(() => {
        if (storage.close === undefined) expect.fail('The PostgreSQL adapter must own close')
        return expect(storage.close()).rejects.toThrow(defect.message)
      })
      expect(value.ended).toBe(true)
      expect(value.totalCount).toBe(0)
    }),
  )

  it.effect('rejects when the real pool rejects a second end', () =>
    Effect.gen(function* () {
      const value = yield* pool
      yield* Effect.tryPromise(() => value.end())
      let notesClosed = false
      const storage = flueStorage(
        value,
        Effect.sync(() => {
          notesClosed = true
        }),
      )
      yield* Effect.tryPromise(() => {
        if (storage.close === undefined) expect.fail('The PostgreSQL adapter must own close')
        return expect(storage.close()).rejects.toHaveProperty('_tag', 'StorageCloseFailed')
      })
      expect(notesClosed).toBe(true)
      expect(value.ended).toBe(true)
      expect(value.totalCount).toBe(0)
    }),
  )
})
