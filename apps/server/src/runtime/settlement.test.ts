import * as NodeNet from 'node:net'
import { NodeHttpClient } from '@effect/platform-node'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { PersonId, ThreadId } from '@vivid/contracts'
import { requestRuntime } from './transport.ts'
import { expect, layer } from '@effect/vitest'
import { Effect, Fiber, Option, Predicate } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { observeRun } from './settlement.ts'

/**
 * An address nothing listens on: a port the system handed out and that was closed again, so a
 * connection to it is refused the way a runtime that is down or being replaced refuses one.
 */
const refusedUrl = Effect.callback<string>((resume) => {
  const listener = NodeNet.createServer()
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address()
    if (address === null || Predicate.isString(address)) {
      listener.close()
      expect.fail('A bound TCP listener has an address and port')
    }
    listener.close(() => resume(Effect.succeed(`http://127.0.0.1:${address.port}/state`)))
  })
})

layer(NodeHttpClient.layerUndici)((it) => {
  // Production, 26 October 2026: the runtime was unavailable for longer than 90 seconds and the
  // server recorded the Run as ended while Flue kept working on it, so every later tool call of
  // that Run was refused. Only the runtime's settlement ends a Run; an unreachable runtime does not.
  it.effect('keeps waiting on a Run while its runtime cannot be reached', () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const url = yield* refusedUrl
      const read = requestRuntime(http, HttpClientRequest.get(url), {
        personId: PersonId.make('unreachable'),
        threadId: ThreadId.make('thread'),
      }).pipe(Effect.as(Option.none()), Effect.scoped)
      const observing = yield* Effect.forkChild(observeRun(read))
      yield* Effect.yieldNow
      yield* TestClock.adjust('2 hours')
      expect(observing.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(observing)
    }),
  )
})
