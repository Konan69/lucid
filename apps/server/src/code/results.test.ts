import { expect, it } from '@effect/vitest'
import { CodeFailure } from '@vivid/contracts/code'
import { Effect } from 'effect'
import { finish } from './results.ts'
import { WorkerMessage } from './protocol.ts'
import { budgets } from './budgets.ts'

/** Exercise the SDK result ingress directly, before any executable or VM needs to boot. */
it.effect('distinguishes unserializable SDK results from oversized JSON results', () =>
  Effect.gen(function* () {
    interface Cyclic {
      self: object
    }
    const cyclic: Cyclic = { self: {} }
    cyclic.self = cyclic
    for (const value of [1n, cyclic]) {
      const result = yield* finish({
        ok: true,
        value,
        output: [],
        calls: [],
        storeWrites: { set: {}, delete: [] },
      })
      expect(result).toEqual(
        WorkerMessage.cases.Failed.make({
          logs: [],
          logsTruncated: false,
          failure: CodeFailure.cases.Threw.make({
            message: 'Program result cannot be serialized as JSON.',
          }),
        }),
      )
    }
    const result = yield* finish({
      ok: true,
      value: 'x'.repeat(budgets.result + 1),
      output: [],
      calls: [],
      storeWrites: { set: {}, delete: [] },
    })
    expect(result).toEqual(
      WorkerMessage.cases.Failed.make({
        logs: [],
        logsTruncated: false,
        failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
      }),
    )
  }),
)

/** Failed SDK executions retain output before interpreter timeout without needing a real wall clock. */
it.effect('keeps printed lines from pi timeout results', () =>
  Effect.gen(function* () {
    const message = yield* finish({
      ok: false,
      error: { kind: 'timeout', message: 'deadline' },
      output: [{ type: 'text', text: 'before timeout' }],
      calls: [],
    })
    expect(message).toEqual(
      WorkerMessage.cases.Failed.make({
        failure: CodeFailure.cases.TimedOut.make({ seconds: 300 }),
        logs: ['before timeout'],
        logsTruncated: false,
      }),
    )
  }),
)
