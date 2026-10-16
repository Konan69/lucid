import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option, Redacted } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as TestClock from 'effect/testing/TestClock'
import { answerIn, failureOf, makeExecutorEvents } from './events.ts'
import { eventsOfApp } from './lifecycle.ts'

/** The MCP answers Executor writes, read as the patched `effect/ai` transport writes them. */
describe('Executor events answers', () => {
  it('reads a JSON answer and the same answer framed as Server-Sent Events', () => {
    const answer = '{"jsonrpc":"2.0","id":1,"result":{"events":[]}}'
    expect(answerIn('application/json', answer)).toEqual(
      Option.some({ id: 1, result: { events: [] } }),
    )
    const framed = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${answer}\n\n`
    expect(answerIn('text/event-stream', framed)).toEqual(
      Option.some({ id: 1, result: { events: [] } }),
    )
    expect(answerIn('application/json', '<html>')).toEqual(Option.none())
  })

  it('maps each MCP events error code to the failure a caller acts on', () => {
    const tag = (code: number, data?: { readonly reason: string }) =>
      failureOf(data === undefined ? { code, message: 'm' } : { code, message: 'm', data })._tag
    expect(tag(-32011)).toBe('ExecutorEventMissing')
    expect(tag(-32012)).toBe('ExecutorEventRefused')
    expect(tag(-32602)).toBe('ExecutorEventArgumentsInvalid')
    expect(tag(-32015, { reason: 'timeout' })).toBe('ExecutorCallbackFailed')
    expect(tag(-32014, { reason: 'schema_changed' })).toBe('ExecutorEventChanged')
    expect(tag(-32014)).toBe('ExecutorEventsUnsupported')
    expect(tag(-32603)).toBe('ExecutorEventsUnreachable')
  })

  it('shows an app’s events without its slug, with each filter’s type', () => {
    const events = eventsOfApp(
      [
        {
          name: 'mail.message.received',
          description: 'A message arrived.',
          inputSchema: { properties: { folder: { type: 'string' }, kind: { const: 'reply' } } },
        },
        { name: 'mailer.sent', description: 'Sent.', inputSchema: {} },
      ],
      'mail',
    )
    expect(events).toEqual([
      {
        event: 'message.received',
        description: 'A message arrived.',
        filters: [
          { name: 'folder', type: 'string' },
          { name: 'kind', type: 'exactly "reply"' },
        ],
      },
    ])
  })
})

/** A whole Executor call is bounded, so a stalled answer cannot hold up a renewal pass. */
describe('Executor events calls', () => {
  it.effect('gives up on an answer whose headers arrived and whose body never ends', () =>
    Effect.gen(function* () {
      const answered = yield* Deferred.make<void>()
      // Headers and the first bytes of the body, then nothing more, ever.
      const stalled = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(answered, undefined)
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'))
            },
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { 'content-type': 'application/json' } }),
          )
        }),
      )
      const events = makeExecutorEvents(stalled, {
        url: 'http://executor.test',
        key: Redacted.make('test-key'),
        organization: 'org_test',
      })
      const listing = yield* Effect.forkChild(events.list)
      yield* Deferred.await(answered)
      yield* TestClock.adjust('29 seconds')
      expect(listing.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 second')
      const failure = yield* Effect.flip(Fiber.join(listing))
      expect(failure._tag).toBe('ExecutorEventsUnreachable')
    }),
  )
})
