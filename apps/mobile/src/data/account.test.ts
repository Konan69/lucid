import { createServer } from 'node:http'
import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Option, Queue, Redacted, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { signOut } from './account'
import { makeCustody, Forgetting, Session } from './session'
import { parseServer } from './server'

/**
 * A real account endpoint drives the same response classifier and bounded revocation program
 * used by the phone. Expo's actual web fetch adapter supplies HTTP; no transport is mocked.
 */
const account = Effect.fn('AccountTest.account')(function* (statuses: ReadonlyArray<number>) {
  let requests = 0
  const failed = yield* Queue.unbounded<string>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((_request, response) => {
        const status = statuses[requests]
        requests += 1
        response.writeHead(status === undefined ? 500 : status, {
          'content-type': 'application/json',
        })
        response.end('{}')
      }),
    ),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)))
        server.closeAllConnections()
      }),
  )
  yield* Effect.callback<void>((resume) => {
    server.listen(0, '127.0.0.1', () => resume(Effect.void))
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    return yield* Effect.die('Expected TCP listener')
  const origin = Result.getOrThrow(parseServer(`http://127.0.0.1:${address.port}`))
  const signedIn = Session.SignedIn({ server: origin, token: Redacted.make('fixture-token') })
  let shown: Session = signedIn
  let owed: Forgetting = Forgetting.Done()
  const custody = makeCustody({
    write: () => Effect.void,
    show: (next) => {
      shown = next
    },
    owed: () => owed,
    owe: (next) => {
      owed = next
    },
  })
  const leave = custody.leave(
    Session.SignedOut({ server: origin }),
    signOut(signedIn).pipe(Effect.tapError((error) => Queue.offer(failed, error._tag))),
  )
  return { leave, failed, requests: () => requests, shown: () => shown, owed: () => owed }
})

it.effect(
  'retries 502, 503 and 429 sign-out responses, then accepts the real acknowledgement',
  () =>
    Effect.gen(function* () {
      const endpoint = yield* account([502, 503, 429, 200])
      const leaving = yield* endpoint.leave.pipe(Effect.forkScoped)
      for (const delay of ['1 second', '2 seconds', '4 seconds'] as const) {
        expect(yield* Queue.take(endpoint.failed)).toBe('AccountUnavailable')
        expect(endpoint.shown()._tag).toBe('SignedOut')
        yield* TestClock.adjust(delay)
      }
      yield* Fiber.join(leaving)
      expect(endpoint.requests()).toBe(4)
      expect(endpoint.owed()._tag).toBe('Done')
    }),
)

for (const status of [401, 403, 422]) {
  it.effect(`stops sign-out at permanent HTTP ${status}`, () =>
    Effect.gen(function* () {
      const endpoint = yield* account([status])
      const answer = yield* Effect.result(endpoint.leave)
      expect(Result.isFailure(answer)).toBe(true)
      expect(Option.getOrThrow(Result.getFailure(answer))._tag).toBe('AccountRefused')
      expect(endpoint.requests()).toBe(1)
      expect(endpoint.shown()._tag).toBe('SignedOut')
      expect(endpoint.owed()._tag).toBe('Done')
    }),
  )
}

it.effect('records a temporary refusal when all four revocation requests fail', () =>
  Effect.gen(function* () {
    const endpoint = yield* account([503, 503, 503, 503])
    const leaving = yield* Effect.result(endpoint.leave).pipe(Effect.forkScoped)
    for (const delay of ['1 second', '2 seconds', '4 seconds'] as const) {
      expect(yield* Queue.take(endpoint.failed)).toBe('AccountUnavailable')
      yield* TestClock.adjust(delay)
    }
    const answer = yield* Fiber.join(leaving)
    expect(Option.getOrThrow(Result.getFailure(answer))._tag).toBe('AccountUnavailable')
    expect(endpoint.requests()).toBe(4)
  }),
)
