import { afterEach, beforeEach, vi } from 'vitest'
import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Predicate, Schema } from 'effect'
import { normalizeContext } from '@earendil-works/pi-ai'
// Load Pi before fake time: these tests control retry waits, not dynamic import scheduling.
import '@earendil-works/pi-ai/api/openai-completions'
import { provider } from './opencode.ts'
import { provider as gateway } from './explabs.ts'

const model = provider.getModels().find((candidate) => candidate.id === 'glm-5.3-flash')
if (model === undefined) throw new Error('Production model is missing')
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] })
const Line = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literal('ProviderWitness'),
    attempt: Schema.Literals([1, 2]),
    status: Schema.Int,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.String,
    request: Schema.Union([
      Schema.TaggedStruct('Decoded', {
        bytes: Schema.Int,
        model: Schema.String,
        messages: Schema.Int,
        roles: Schema.String,
        tools: Schema.Int,
        stream: Schema.Union([Schema.Boolean, Schema.Literal('unset')]),
      }),
      Schema.TaggedStruct('Undecoded', { bytes: Schema.Int }),
    ]),
  }),
)
const decodeLine = Schema.decodeUnknownSync(Line)

/** Observe actual Effect warning output; the receipt acknowledges the refusal before time moves. */
function capture() {
  const lines: Array<typeof Line.Type> = []
  const first = Deferred.makeUnsafe<void>()
  const log = vi.spyOn(console, 'log').mockImplementation((...args: ReadonlyArray<unknown>) => {
    for (const argument of args) {
      if (!Predicate.isString(argument) || !argument.startsWith('{"event":"ProviderWitness"'))
        continue
      lines.push(decodeLine(argument))
      Deferred.doneUnsafe(first, Effect.void)
    }
  })
  return { lines, first: Deferred.await(first), log }
}

/** Pi consumes a real completion stream; no SDK adapter or witness is mocked. */
const completion = () =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('provider refusal witnesses', () => {
  for (const method of ['stream', 'streamSimple'] as const) {
    it.effect(`${method} replays an empty 400 once after 300 ms and witnesses both attempts`, () =>
      Effect.gen(function* () {
        const captured = capture()
        const sent: Array<{
          readonly url: string
          readonly method: string
          readonly headers: ReadonlyArray<readonly [string, string]>
          readonly body: string
        }> = []
        const fetch = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
          const request = new Request(input, init)
          return request.text().then((body) => {
            sent.push({
              url: request.url,
              method: request.method,
              headers: [...request.headers],
              body,
            })
            return sent.length === 1 ? new Response(null, { status: 400 }) : completion()
          })
        })
        const result = provider[method](model, context, { apiKey: 'test', fetch }).result()
        yield* captured.first
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(299))
        expect(fetch).toHaveBeenCalledTimes(1)
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
        const answer = yield* Effect.promise(() => result)
        expect(answer.stopReason).toBe('stop')
        expect(answer.content).toEqual([{ type: 'text', text: 'ready' }])
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(sent).toHaveLength(2)
        expect(sent[1]).toEqual(sent[0])
        expect(captured.lines.map(({ attempt, status }) => ({ attempt, status }))).toEqual([
          { attempt: 1, status: 400 },
          { attempt: 2, status: 200 },
        ])
      }),
    )
  }

  it.effect('returns Pi’s unchanged error after two empty 400 responses', () =>
    Effect.gen(function* () {
      const captured = capture()
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 400 })))
      const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
      yield* captured.first
      yield* Effect.promise(() => vi.runAllTimersAsync())
      const answer = yield* Effect.promise(() => result)
      expect(answer.stopReason).toBe('error')
      expect(answer.errorMessage).toBe('400 status code (no body)')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(captured.lines.map(({ attempt, status }) => ({ attempt, status }))).toEqual([
        { attempt: 1, status: 400 },
        { attempt: 2, status: 400 },
      ])
    }),
  )

  it.effect('keeps a deterministic JSON refusal readable and logs only identifying headers', () =>
    Effect.gen(function* () {
      const captured = capture()
      const body = JSON.stringify({ error: { message: 'invalid tools' } })
      const headers = {
        'x-request-id': 'request-1',
        'request-id': 'request-2',
        'cf-ray': 'ray-1',
        'x-opencode-trace': 'trace-1',
        'retry-after': '1',
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength),
        authorization: 'secret-response-key',
        'set-cookie': 'secret-cookie',
      }
      const fetch = vi.fn(() => Promise.resolve(new Response(body, { status: 400, headers })))
      const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
      const answer = yield* Effect.promise(() => result)
      expect(answer.stopReason).toBe('error')
      expect(answer.errorMessage).toContain('invalid tools')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(captured.lines).toHaveLength(1)
      expect(captured.lines[0]).toMatchObject({
        body,
        status: 400,
        attempt: 1,
        headers: {
          'x-request-id': 'request-1',
          'request-id': 'request-2',
          'cf-ray': 'ray-1',
          'x-opencode-trace': 'trace-1',
          'retry-after': '1',
          'content-type': 'application/json',
          'content-length': headers['content-length'],
        },
      })
      expect(JSON.stringify(captured.log.mock.calls)).not.toContain('secret-response-key')
      expect(JSON.stringify(captured.log.mock.calls)).not.toContain('secret-cookie')
    }),
  )

  it.effect('leaves a 500 to Pi’s retry policy and witnesses its refusal once', () =>
    Effect.gen(function* () {
      const captured = capture()
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(completion())
      const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
      yield* captured.first
      yield* Effect.promise(() => vi.runAllTimersAsync())
      expect((yield* Effect.promise(() => result)).stopReason).toBe('stop')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(captured.lines.map(({ status }) => status)).toEqual([500])
    }),
  )

  it.effect(
    'reports actual wire roles and bytes without message text, tool arguments or results',
    () =>
      Effect.gen(function* () {
        const captured = capture()
        const privateContext = normalizeContext({
          systemPrompt: 'sk-message-private-123',
          tools: [
            {
              name: 'read',
              description: 'sk-tool-description',
              parameters: { type: 'object', properties: {} },
            },
          ],
          messages: [
            { role: 'user', content: 'sk-message-private-123 é', timestamp: 0 },
            {
              role: 'assistant',
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: 0,
              content: [
                {
                  type: 'toolCall',
                  id: 'one',
                  name: 'read',
                  arguments: { key: 'sk-argument-private-123' },
                },
                {
                  type: 'toolCall',
                  id: 'two',
                  name: 'read',
                  arguments: { key: 'sk-argument-private-123' },
                },
              ],
              stopReason: 'toolUse',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
            {
              role: 'toolResult',
              toolCallId: 'one',
              toolName: 'read',
              content: [{ type: 'text', text: 'sk-result-private-123' }],
              isError: false,
              timestamp: 0,
            },
            {
              role: 'toolResult',
              toolCallId: 'two',
              toolName: 'read',
              content: [{ type: 'text', text: 'sk-result-private-123' }],
              isError: true,
              timestamp: 0,
            },
            { role: 'user', content: 'continue', timestamp: 0 },
          ],
        })
        let bytes = 0
        const fetch = vi.fn((input: string | URL | Request, init: RequestInit = {}) =>
          new Request(input, init)
            .clone()
            .arrayBuffer()
            .then((body) => {
              bytes = body.byteLength
              return new Response('refused', { status: 400 })
            }),
        )
        const result = provider
          .streamSimple(model, privateContext, { apiKey: 'sk-request-private-123', fetch })
          .result()
        expect((yield* Effect.promise(() => result)).stopReason).toBe('error')
        expect(captured.lines[0]).toMatchObject({
          request: {
            model: model.id,
            messages: 6,
            roles: 's u a(2) t t u',
            tools: 1,
            bytes,
            stream: true,
          },
        })
        const output = JSON.stringify(captured.log.mock.calls)
        for (const secret of [
          'sk-message-private-123',
          'sk-argument-private-123',
          'sk-result-private-123',
          'sk-request-private-123',
          'sk-tool-description',
        ]) {
          expect(output).not.toContain(secret)
        }
      }),
  )

  it.effect('records explicit tool error flags when the request payload actually has them', () =>
    Effect.gen(function* () {
      const captured = capture()
      const fetch = vi.fn(() => Promise.resolve(new Response('refused', { status: 400 })))
      const result = provider
        .streamSimple(model, context, {
          apiKey: 'test',
          fetch,
          onPayload: () => ({
            model: model.id,
            stream: true,
            messages: [
              { role: 'system', content: 'private' },
              { role: 'user', content: 'private' },
              { role: 'assistant', tool_calls: [{}, {}] },
              { role: 'tool', isError: false },
              { role: 'tool', is_error: true },
              { role: 'user', content: 'private' },
            ],
          }),
        })
        .result()
      yield* Effect.promise(() => result)
      expect(captured.lines[0]).toMatchObject({ request: { roles: 's u a(2) t t! u', tools: 0 } })
    }),
  )

  it.effect('does not issue a second fetch when aborted during the 300 ms wait', () => {
    // The caller owns this external signal; interrupting the test fiber would abort assertions too.
    const controller = new AbortController()
    return Effect.gen(function* () {
      const captured = capture()
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 400 })))
      const result = provider
        .streamSimple(model, context, { apiKey: 'test', fetch, signal: controller.signal })
        .result()
      yield* captured.first
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(150))
      controller.abort()
      yield* Effect.promise(() => vi.runAllTimersAsync())
      expect((yield* Effect.promise(() => result)).stopReason).toBe('aborted')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(captured.lines).toHaveLength(1)
    })
  })

  it.effect('bounds the excerpt and counts undecoded request bytes without inventing a shape', () =>
    Effect.gen(function* () {
      const captured = capture()
      const body = 'é'.repeat(2200)
      const payload = 'sk-undecoded-private-123'
      const fetch = vi.fn(() => Promise.resolve(new Response(body, { status: 400 })))
      const result = provider
        .streamSimple(model, context, { apiKey: 'test', fetch, onPayload: () => payload })
        .result()
      yield* Effect.promise(() => result)
      expect(captured.lines[0]).toMatchObject({
        body: body.slice(0, 2048),
        request: {
          bytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        },
      })
      expect(JSON.stringify(captured.log.mock.calls)).not.toContain(payload)
      expect(captured.lines.map(({ request }) => request._tag)).toEqual(['Undecoded'])
      expect(fetch).toHaveBeenCalledTimes(1)
    }),
  )

  it.effect('applies the same witness to the retained gateway and the default platform fetch', () =>
    Effect.gen(function* () {
      const captured = capture()
      const gatewayModel = gateway.getModels().find((candidate) => candidate.id === 'glm-5.3-flash')
      if (gatewayModel === undefined) throw new Error('Gateway model is missing')
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 400 }))
        .mockResolvedValueOnce(completion())
      const result = gateway.streamSimple(gatewayModel, context, { apiKey: 'test' }).result()
      yield* captured.first
      yield* Effect.promise(() => vi.runAllTimersAsync())
      expect((yield* Effect.promise(() => result)).stopReason).toBe('stop')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(captured.lines).toHaveLength(2)
    }),
  )
})
