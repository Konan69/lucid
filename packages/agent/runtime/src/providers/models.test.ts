import * as NodeHttp from 'node:http'
import * as NodeEvents from 'node:events'
import * as NodeUtil from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { contentText, type Provider } from '@earendil-works/pi-ai'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { Array, ConfigProvider, Effect, Option, Predicate, Result } from 'effect'
import { makeProviders, ModelUnavailable } from './models.ts'

/** ConfigProvider supplies invented settings; no case reads an ambient provider key. */
const configured = (values: Record<string, string>) =>
  makeProviders().pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true }),
    ),
  )

/** The fixture changes only the peer address; production auth, headers and streaming stay real. */
function local(provider: Provider, baseUrl: string): Provider {
  return {
    ...provider,
    getModels: () => provider.getModels().map((model) => Object.assign({}, model, { baseUrl })),
  }
}

/** Register cleanup before listening so a failed request never leaves a test server running. */
const peer = (handle: NodeHttp.RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => NodeHttp.createServer(handle)),
      (resource) => Effect.promise(() => NodeUtil.promisify(resource.close.bind(resource))()),
    )
    const listening = NodeEvents.EventEmitter.once(server, 'listening')
    server.listen(0, '127.0.0.1')
    yield* Effect.promise(() => listening)
    const address = server.address()
    if (address === null || Predicate.isString(address)) throw new Error('Missing test peer port')
    return `http://127.0.0.1:${address.port}/v1`
  })

/** A minimal real SSE answer exercises Pi's parser and the Harness generation task. */
function answer(response: NodeHttp.ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    'data: {"choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
  )
}

describe('Harness model composition', () => {
  it.effect("selects main's default and keeps the gateways' declared capabilities and costs", () =>
    Effect.gen(function* () {
      const { models, model, modelName } = yield* configured({})
      expect(modelName).toBe('opencode-go/glm-5.3-flash')
      expect(model).toEqual({ provider: 'opencode-go', modelId: 'glm-5.3-flash' })
      expect(
        models.getModels().map((candidate) => `${candidate.provider}/${candidate.id}`),
      ).toEqual([
        'opencode-go/glm-5.3-flash',
        'opencode-go/glm-5.3',
        'openrouter/z-ai/glm-5.3-flash',
        'openrouter/deepseek/deepseek-v4.1-flash-1017',
      ])
      for (const candidate of models.getModels()) {
        expect(candidate).toMatchObject({
          api: 'openai-completions',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: candidate.provider === 'openrouter' ? 1_048_576 : 1_310_720,
          maxTokens: candidate.id === 'deepseek/deepseek-v4.1-flash-1017' ? 393_216 : 131_072,
        })
      }
      expect(yield* Effect.promise(() => models.getAuth('opencode-go'))).toBeUndefined()
    }),
  )

  it.effect(
    'selects every declared alternate and rejects undeclared or similarly named models',
    () =>
      Effect.gen(function* () {
        for (const name of [
          'opencode-go/glm-5.3',
          'openrouter/z-ai/glm-5.3-flash',
          'openrouter/deepseek/deepseek-v4.1-flash-1017',
        ]) {
          const selected = yield* configured({ VIVID_MODEL: name })
          expect(`${selected.model.provider}/${selected.model.modelId}`).toBe(name)
          expect(selected.models.getProvider('rehearsal')).toBeUndefined()
        }
        for (const name of ['', 'rehearsalish/script', 'rehearsal/missing', 'openrouter/missing']) {
          const result = yield* Effect.result(configured({ VIVID_MODEL: name }))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(ModelUnavailable)
            expect(result.failure).toMatchObject({ model: name })
          }
        }
      }),
  )

  it.effect('isolates scripted queues across concurrent and repeated calls without a key', () =>
    Effect.gen(function* () {
      const { models, model } = yield* configured({ VIVID_MODEL: 'rehearsal/script' })
      const selected = models.getModel(model.provider, model.modelId)
      if (selected === undefined) throw new Error('Missing rehearsal model')
      const table = {
        messages: [{ role: 'user' as const, content: 'show a table', timestamp: 10 }],
      }
      const program = {
        messages: [{ role: 'user' as const, content: 'run a program', timestamp: 20 }],
      }
      const results = yield* Effect.all(
        [
          Effect.promise(() => models.completeSimple(selected, table)),
          Effect.promise(() => models.complete(selected, program)),
          Effect.promise(() => models.completeSimple(selected, table)),
        ],
        { concurrency: 'unbounded' },
      )
      const [first, second, repeated] = results
      if (first === undefined || second === undefined || repeated === undefined)
        throw new Error('Missing scripted response')
      expect(first).toEqual(repeated)
      expect(contentText(first.content)).toContain('```openui-lang')
      expect(first.content.some((block) => block.type === 'toolCall')).toBe(false)
      expect(second.content).toMatchObject([{ type: 'toolCall', name: 'run_code' }])
    }),
  )

  it.live('uses the retained gateway key through both public Models stream methods', () =>
    Effect.gen(function* () {
      const sent: NodeHttp.IncomingHttpHeaders[] = []
      const baseUrl = yield* peer((request, response) => {
        sent.push(request.headers)
        request.resume()
        answer(response)
      })
      const { models, model, settings } = yield* configured({
        VIVID_MODEL: 'openrouter/z-ai/glm-5.3-flash',
        OPENROUTER_API_KEY: 'invented-openrouter-test-key',
      })
      const gateway = models.getProvider(model.provider)
      if (gateway === undefined) throw new Error('Missing OpenRouter provider')
      models.setProvider(local(gateway, baseUrl))
      const selected = models.getModel(model.provider, model.modelId)
      if (selected === undefined) throw new Error('Missing gateway model')
      for (const method of ['stream', 'streamSimple'] as const) {
        const result = yield* Effect.promise(() =>
          models[method](
            selected,
            {
              messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
            },
            settings.stream,
          ).result(),
        )
        expect(result.stopReason).toBe('stop')
        expect(contentText(result.content)).toBe('ready')
      }
      expect(sent.map((headers) => headers.authorization)).toEqual([
        'Bearer invented-openrouter-test-key',
        'Bearer invented-openrouter-test-key',
      ])
      expect(sent.map((headers) => headers['x-opencode-session'])).toEqual([undefined, undefined])
    }).pipe(Effect.scoped),
  )

  it.live(
    'forwards the conversation session and stream budget through real Harness HTTP requests',
    () =>
      Effect.gen(function* () {
        const sent: NodeHttp.IncomingHttpHeaders[] = []
        const baseUrl = yield* peer((request, response) => {
          sent.push(request.headers)
          request.resume()
          // A zero provider delay exercises the retry without any arbitrary test wait.
          if (sent.length === 1) {
            response.writeHead(503, { 'retry-after-ms': '0' })
            response.end('temporarily unavailable')
          } else answer(response)
        })
        const configuredModels = yield* configured({
          OPENCODE_API_KEY: 'invented-opencode-test-key',
        })
        const provider = configuredModels.models.getProvider('opencode-go')
        if (provider === undefined) throw new Error('Missing OpenCode provider')
        configuredModels.models.setProvider(local(provider, baseUrl))
        const harness = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Harness.open(
              new MemoryStorage(),
              {
                ...configuredModels,
                registry: createRegistry(),
                settings: { ...configuredModels.settings, retry: { enabled: false } },
              },
              BACKGROUND_CONTEXT,
            ),
          ),
          (resource) => Effect.promise(() => resource.close(BACKGROUND_CONTEXT)),
        )
        const root = yield* Effect.promise(() =>
          harness.root(BACKGROUND_CONTEXT, { agent: { model: configuredModels.model } }),
        )
        for (const content of ['hello', 'again']) {
          const submitted = yield* Effect.promise(() =>
            root.submit({ type: 'input', content }, BACKGROUND_CONTEXT),
          )
          yield* Effect.promise(() => submitted.wait(BACKGROUND_CONTEXT))
        }
        const other = yield* Effect.promise(() =>
          harness.createConversation(
            { ownership: { kind: 'ownerless' }, agent: { model: configuredModels.model } },
            BACKGROUND_CONTEXT,
          ),
        )
        const submitted = yield* Effect.promise(() =>
          other.submit({ type: 'input', content: 'hello' }, BACKGROUND_CONTEXT),
        )
        yield* Effect.promise(() => submitted.wait(BACKGROUND_CONTEXT))
        expect(sent).toHaveLength(4)
        const sessions = sent.map((headers) => headers['x-opencode-session'])
        expect(sessions[0]).toEqual(expect.any(String))
        expect(sessions.slice(0, 3)).toEqual([sessions[0], sessions[0], sessions[0]])
        expect(sessions[3]).not.toBe(sessions[0])
        for (const headers of sent) {
          expect(headers['user-agent']).toBe('vivid-runtime')
          expect(headers.authorization).toBe('Bearer invented-opencode-test-key')
        }
        const view = yield* Effect.promise(() => root.context(BACKGROUND_CONTEXT))
        const last = Array.findLast(view.messages, (message) => message.role === 'assistant')
        if (Option.isNone(last)) throw new Error('Missing assistant answer')
        expect(last.value.stopReason).toBe('stop')
        expect(contentText(last.value.content)).toBe('ready')
      }).pipe(Effect.scoped),
  )
})
