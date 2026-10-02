import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { AgentRunError, init, useModel } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import { postgres, type PostgresRunner } from '@flue/postgres'
import { RunId, RunState } from '@vivid/contracts'
import { Config, Effect, Redacted, Stream } from 'effect'
import { Pool } from 'pg'
import { testDatabaseConfigured } from '../../../../../apps/server/src/database/testdb.ts'
import {
  classifyFailure,
  decodeFailureEvidence,
} from '../../../../../apps/server/src/runtime/failure.ts'
import { StoredRunOrigin } from '../../../../../apps/server/src/threads/conversation.ts'
import { RunEnding, RunStore } from '../../../../../apps/server/src/threads/runs.ts'
import { ModelName, ModelUnavailable } from './failure.ts'
import { ModelStream } from './stream.ts'

import { productFixture, productLayer } from '../../../../../apps/server/src/runtime/testing.ts'
const builtIn = openrouterProvider()
const model = builtIn.getModels()[0]

/** An opaque thrown message proves classification depends on the terminal event's typed tag. */
class OpaqueFailure extends ModelUnavailable {
  override get message() {
    return 'Opaque provider diagnostic'
  }
}

/** Real Flue execution exercises error-event handling, operation failure, and settlement serialization. */
function FailureTest() {
  if (model === undefined) expect.fail('The installed provider needs a catalog model')
  useModel(`openrouter/${model.id}`)
  return 'Answer the message.'
}
FailureTest.agentName = 'failure-test'
FailureTest.durability = { maxAttempts: 1 }

/** Each Flue test owns a schema on the disposable URL; cleanup is registered before schema creation. */
const flueDatabase = Effect.fn('Models.test.database')(function* () {
  const url = yield* Config.Redacted('VIVID_TEST_DATABASE_URL')
  const namespace = `runtime_test_${NodeCrypto.randomUUID().replaceAll('-', '')}`
  const pool = new Pool({
    connectionString: Redacted.value(url),
    options: `-c search_path=${namespace}`,
  })
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => pool.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`)).pipe(
      Effect.ensuring(Effect.promise(() => pool.end())),
      Effect.catch(() => Effect.sync(() => expect.fail('Flue fixture cleanup failed'))),
    ),
  )
  yield* Effect.tryPromise(() => pool.query(`CREATE SCHEMA ${namespace}`))
  const runner: PostgresRunner = {
    query: async (text, params) => (await pool.query(text, params)).rows,
    /** SDK transactions must release the connection even when the callback rejects. */
    transaction: (fn) =>
      // Flue invokes this Promise-only transaction callback; it.live still owns the test runtime.
      // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library
      Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.tryPromise(() => pool.connect()),
          (client) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise(() => client.query('BEGIN'))
              const value = yield* Effect.tryPromise(() =>
                fn({ query: async (text, params) => (await client.query(text, params)).rows }),
              ).pipe(Effect.tapError(() => Effect.promise(() => client.query('ROLLBACK'))))
              yield* Effect.tryPromise(() => client.query('COMMIT'))
              return value
            }),
          (client) => Effect.sync(() => client.release()),
        ),
      ),
    close: () => undefined,
  }
  return postgres(runner)
})

describe.skipIf(!testDatabaseConfigured)('provider failure settlement chain', () => {
  it.live('records a classified provider failure through real Flue settlement and RunStore', () =>
    Effect.gen(function* () {
      if (model === undefined) expect.fail('The installed provider needs a catalog model')
      const db = yield* flueDatabase()
      const provider = {
        ...builtIn,
        // pi-ai Models applies auth before invoking our stream. This controlled provider is
        // keyless, like pi-ai's faux provider; no real credentials or network are involved.
        auth: { apiKey: { name: 'Controlled test provider', resolve: async () => ({ auth: {} }) } },
        streamSimple: () =>
          new ModelStream(
            Stream.fail(new OpaqueFailure({ model: ModelName.make(model.id), transient: false })),
            model,
          ),
      }
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => start({ agents: [FailureTest], providers: [provider], db })),
        (runtime) => Effect.promise(() => runtime[Symbol.asyncDispose]()),
      )
      const { personId, threadId } = yield* productFixture()
      const handle = init(FailureTest, { id: threadId })
      const receipt = yield* Effect.tryPromise(() => handle.dispatch('Hello'))
      const id = RunId.make(receipt.submissionId)
      const store = yield* RunStore
      yield* store.start({
        libraryFolder: null,
        id,
        personId,
        threadId,
        origin: StoredRunOrigin.cases.Message.make({}),
      })
      const reason = yield* Effect.tryPromise({
        try: () => handle.read(receipt),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => expect.fail('Provider failure must fail the submission')),
        ),
        Effect.catch((error) =>
          error instanceof AgentRunError
            ? Effect.succeed(classifyFailure(decodeFailureEvidence(error.cause)))
            : Effect.die(error),
        ),
      )
      yield* store.end(id, RunEnding.cases.Failed.make({ reason }))
      const recorded = yield* store.list(threadId)
      expect(recorded).toHaveLength(1)
      const row = recorded[0]
      if (row === undefined) expect.fail('The Run must be recorded')
      expect(RunState.guards.Failed(row.state)).toBe(true)
      if (RunState.guards.Failed(row.state)) expect(row.state.reason).toBe('ModelUnavailable')
    }).pipe(Effect.scoped, Effect.provide(productLayer)),
  )
})
