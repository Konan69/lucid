import * as NodeNet from 'node:net'
import { createFlueClient } from '@flue/sdk'
import { describe, expect, it } from '@effect/vitest'
import { RunId } from '@vivid/contracts'
import { Effect, Fiber } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { observeRun } from './settlement.ts'

/**
 * An address nothing listens on: a port the system handed out and that was closed again, so a
 * connection to it is refused the way a runtime that is down or being replaced refuses one.
 */
const refusedUrl = Effect.callback<string>((resume) => {
  const listener = NodeNet.createServer()
  listener.listen(0, '127.0.0.1', () => {
    // SAFETY: a TCP listener bound to a host and port reports AddressInfo (`net.Server.address`, Node 24).
    const { port } = listener.address() as NodeNet.AddressInfo
    listener.close(() => resume(Effect.succeed(`http://127.0.0.1:${port}/agents/vivid/thread`)))
  })
})

describe('observeRun', () => {
  // Production, 26 October 2026: the runtime was unavailable for longer than 90 seconds and the
  // server recorded the Run as ended while Flue kept working on it, so every later tool call of
  // that Run was refused. Only Flue's settlement ends a Run; an unreachable runtime does not.
  it.effect('keeps waiting on a Run while its runtime cannot be reached', () =>
    Effect.gen(function* () {
      const client = createFlueClient({ url: yield* refusedUrl, token: 'unused' })
      const observing = yield* Effect.forkChild(observeRun(client, RunId.make('run-unreachable')))
      yield* Effect.yieldNow
      yield* TestClock.adjust('2 hours')
      expect(observing.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(observing)
    }),
  )
})
