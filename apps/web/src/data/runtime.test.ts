import { VividRpcClient } from '@vivid/client-runtime'
import { Unauthenticated } from '@vivid/contracts'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { run, clientFailure } from './runtime'

describe('web RPC runtime', () => {
  it.effect('provides the generated client at the single web runtime boundary', () =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          return client.ListThreads
        }),
      ),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isSuccess(result)).toBe(true)
          if (Result.isSuccess(result)) expect(result.success).toBeDefined()
        }),
      ),
    ),
  )

  it.effect('keeps contract failures in the Result returned to screens', () =>
    Effect.promise(() => run(Effect.fail(Unauthenticated.make({ message: 'Sign in' })))).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure.message).toBe('Sign in')
        }),
      ),
    ),
  )

  it.effect('keeps browser-only adapter failures renderable', () =>
    Effect.promise(() => run(Effect.fail(clientFailure('Could not reach Vivid.', 'offline')))).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result))
            expect(result.failure.message).toContain('Could not reach Vivid.')
        }),
      ),
    ),
  )
})
