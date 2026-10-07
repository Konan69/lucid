import { consume, consumeReadable } from './fixtures/reading.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry } from '@earendil-works/pi-durable'
import { tool, lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Deferred, Option } from 'effect'
import { z } from 'zod'

import {
  streamRun,
  toolsExtension,
  ToolSchemaFailed,
  type ToolsOptions,
  type Replay,
} from './core.ts'
import { FixtureFailed, memory } from './fixtures/harness.ts'
import { PlainChat } from './fixtures/chat.ts'
import { host, call } from './conformance/fixtures/host.ts'
import { streamRun as streamSdk, answer, waiting } from './main.ts'

const context = BACKGROUND_CONTEXT

/** One run on a harness whose only tools are the given AI SDK tools; returns the final message. */
const run = Effect.fn('Test.runTool')(function* (
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
) {
  const seen: { item: string; currency: string }[] = []
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'shop',
      {
        price: tool({
          description: 'Price of an item',
          inputSchema: z.object({ item: z.string(), currency: z.string().default('NGN') }),
          execute: (input) => {
            seen.push(input)
            return Promise.resolve({ amount: 1500, currency: input.currency })
          },
        }),
      },
      {},
    ),
  )
  const harness = yield* memory(models, registry)
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  const { message } = yield* consume(
    streamRun(harness, { conversationId: root.id, content: 'Price?', requestId: 'p1' }, context),
    Option.none(),
  )
  return { message, seen }
})

it.live('runs an AI SDK tool with a Zod input schema inside Pi Durable', () =>
  Effect.gen(function* () {
    const { message, seen } = yield* run([
      fauxAssistantMessage([fauxToolCall('price', { item: 'rice' }, { id: 'c1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('1500 NGN.'),
    ])

    // The Zod default was applied: the tool's own validator ran, not only the JSON Schema check.
    expect(seen).toEqual([{ item: 'rice', currency: 'NGN' }])
    // A bridged tool is a typed part with the tool's own output, as `streamText` would give it.
    expect(message.parts.find((part) => part.type === 'tool-price')).toMatchObject({
      state: 'output-available',
      input: { item: 'rice' },
      output: { amount: 1500, currency: 'NGN' },
    })
  }),
)

it.live('rejects arguments that do not match the schema before the tool runs', () =>
  Effect.gen(function* () {
    const { message, seen } = yield* run([
      // Pi Durable coerces a number to a string, so a wrong type is not invalid. A missing field is.
      fauxAssistantMessage([fauxToolCall('price', { currency: 'USD' }, { id: 'c2' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Sorry.'),
    ])

    expect(seen).toEqual([])
    expect(message.parts.find((part) => part.type === 'tool-price')).toMatchObject({
      state: 'output-error',
    })
  }),
)

/** Registration identifies the exact tool whose schema cannot be represented as JSON Schema. */
it.live('names a tool whose SDK schema cannot be built', () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(
      toolsExtension(
        'unsupported',
        {
          symbolic: tool({
            description: 'Requires a symbol',
            inputSchema: z.object({ value: z.symbol() }),
          }),
        },
        {},
      ),
    )
    expect(failed).toBeInstanceOf(ToolSchemaFailed)
    expect(failed.toolName).toBe('symbolic')
  }),
)

/** Rejected SDK execution and invalid durable output are separate failures, both reported as tool errors. */
it.live('presents SDK rejection and serialization failure as tool output errors', () =>
  Effect.gen(function* () {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('broken', {}, { id: 'reject' }),
          fauxToolCall('unserializable', {}, { id: 'json' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('The tools failed.'),
    ])
    const registry = createRegistry()
    registry.install(
      yield* toolsExtension(
        'failures',
        {
          broken: tool({
            description: 'Rejects execution',
            inputSchema: z.object({}),
            execute: (): Promise<string> => Promise.reject(new Error('ledger offline')),
          }),
          unserializable: tool({
            description: 'Returns a non JSON number',
            inputSchema: z.object({}),
            execute: () => Promise.resolve({ amount: 1n }),
          }),
        },
        {},
      ),
    )
    const harness = yield* memory(models, registry)
    const root = yield* Effect.promise(() =>
      harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    )
    const { message } = yield* consume(
      streamRun(
        harness,
        { conversationId: root.id, content: 'Try both', requestId: 'failures' },
        context,
      ),
      Option.none(),
    )
    expect(message.parts.find((part) => part.type === 'tool-broken')).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('ledger offline'),
    })
    expect(message.parts.find((part) => part.type === 'tool-unserializable')).toMatchObject({
      state: 'output-error',
    })
  }),
)

/** A void SDK execute is a successful null result, with explicit text for the model. */
it.live('persists null for a void tool and gives the model explicit null text', () =>
  Effect.gen(function* () {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    let executions = 0
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('notify', {}, { id: 'void' })], { stopReason: 'toolUse' }),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: 'toolResult',
          content: [{ type: 'text', text: 'null' }],
        })
        return fauxAssistantMessage('Notified.')
      },
    ])
    registry.install(
      yield* toolsExtension(
        'void',
        {
          notify: tool({
            inputSchema: z.object({}),
            execute: () => {
              executions++
              return Promise.resolve()
            },
          }),
        },
        {},
      ),
    )
    const harness = yield* memory(models, registry)
    const root = yield* Effect.promise(() =>
      harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    )
    const { message } = yield* consume(
      streamRun(
        harness,
        { conversationId: root.id, content: 'Notify', requestId: 'void' },
        context,
      ),
      Option.none(),
    )
    expect(executions).toBe(1)
    expect(message.parts.find((part) => part.type === 'tool-notify')).toMatchObject({
      state: 'output-available',
      output: null,
    })
    expect(message.parts.at(-1)).toMatchObject({ type: 'text', text: 'Notified.' })
  }),
)

/** Refuse SDK features whose behavior cannot be represented by Pi's native tool registration. */
for (const sample of [
  {
    name: 'provider-executed',
    value: tool({
      type: 'provider',
      id: 'test.remote',
      args: {},
      isProviderExecuted: true,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      supportsDeferredResults: true,
    }),
  },
  {
    name: 'provider-defined',
    value: tool({
      type: 'provider',
      id: 'test.local',
      args: {},
      isProviderExecuted: false,
      inputSchema: z.object({}),
      execute: () => Promise.resolve('local'),
    }),
  },
  {
    name: 'functional-description',
    value: tool({
      description: () => 'Scoped description',
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  {
    name: 'deferred-discovery',
    value: tool({
      deferLoading: true,
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  {
    name: 'provider-options',
    value: tool({
      providerOptions: { openai: { cacheControl: 'required' } },
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  {
    name: 'input-start',
    value: tool({
      onInputStart: () => {},
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  {
    name: 'input-delta',
    value: tool({
      onInputDelta: () => {},
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  {
    name: 'input-available',
    value: tool({
      onInputAvailable: () => {},
      inputSchema: z.object({}),
      execute: () => Promise.resolve('done'),
    }),
  },
  { name: 'answer-approval', value: tool({ needsApproval: true, inputSchema: z.object({}) }) },
])
  it.live(`refuses ${sample.name} tools at registration`, () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        toolsExtension('unsupported', { [sample.name]: sample.value }, {}),
      )
      expect(failed).toBeInstanceOf(ToolSchemaFailed)
      expect(failed.toolName).toBe(sample.name)
    }),
  )

/** Empty provider metadata has no semantics to lose; non-empty metadata remains refused above. */
it.live('runs a tool with empty providerOptions', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        empty: tool({
          providerOptions: {},
          inputSchema: z.object({}),
          execute: () => Promise.resolve('accepted'),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('empty', {}, 'empty'), fauxAssistantMessage('Done.')])
    const stream = yield* Effect.promise(() =>
      streamSdk(
        opened.harness,
        { conversationId: opened.root.id, content: 'Run', requestId: 'empty-options' },
        context,
      ),
    )
    const result = yield* consumeReadable(stream, Option.none())
    expect(result.message.parts.find((part) => part.type === 'tool-empty')).toMatchObject({
      output: 'accepted',
    })
  }),
)

/** Pi exposes constrained sampling through registration; the faux request must receive the declaration. */
for (const strict of [true, false, undefined])
  it.live(`carries SDK strict=${String(strict)} into the Pi model request`, () =>
    Effect.gen(function* () {
      const fixture = yield* host(
        {
          sampling: tool({
            strict,
            inputSchema: z.object({}),
            execute: () => Promise.resolve('sampled'),
          }),
        },
        {},
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        (request) => {
          const offered = getCurrentTools(request.messages).find(
            (entry) => entry.name === 'sampling',
          )
          if (offered === undefined) throw new Error('Expected model tool declaration')
          expect(offered.constrainedSampling).toEqual(
            strict === true ? { type: 'json_schema', strict: 'prefer' } : strict,
          )
          return call('sampling', {}, 'sampling')
        },
        fauxAssistantMessage('Done.'),
      ])
      const stream = yield* Effect.promise(() =>
        streamSdk(
          opened.harness,
          { conversationId: opened.root.id, content: 'Run', requestId: `strict-${String(strict)}` },
          context,
        ),
      )
      const result = yield* consumeReadable(stream, Option.none())
      expect(result.message.parts.find((part) => part.type === 'tool-sampling')).toMatchObject({
        output: 'sampled',
      })
    }),
  )

/** No input exists at registration to evaluate a predicate; neither form can create two kinds of hold. */
for (const sample of [
  { name: 'boolean', rule: true },
  { name: 'function', rule: () => false },
])
  it.live(`refuses host ${sample.name} approval on an answer-only tool`, () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        toolsExtension(
          'unsupported',
          { ask: tool({ inputSchema: z.object({}) }) },
          { approval: { ask: sample.rule } },
        ),
      )
      expect(failed).toBeInstanceOf(ToolSchemaFailed)
      expect(failed.toolName).toBe('ask')
      expect(failed.message).toContain('approval before person-supplied output')
    }),
  )

/** Reserved names must respect own replay entries while ignoring builtin and custom prototypes. */
for (const name of ['constructor', '__proto__'])
  for (const policy of ['absent', 'inherited', 'own'] as const)
    it.live(`uses own per-tool options for server tool ${name} (${policy})`, () =>
      Effect.gen(function* () {
        const replay: Record<string, Replay> = {}
        if (policy === 'inherited') Object.setPrototypeOf(replay, { [name]: 'safe' })
        if (policy === 'own')
          Object.defineProperty(replay, name, { value: 'safe', enumerable: true })
        const fixture = yield* host(
          { [name]: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('done') }) },
          { replay },
        )
        const opened = yield* fixture.open()
        const registered = (yield* Effect.promise(() => opened.root.agent(context))).tools.find(
          (entry) => entry.name === name,
        )
        if (registered === undefined) throw new Error('Expected registered tool')
        expect(registered.replay).toBe(policy === 'own' ? 'safe' : 'unsafe')
        opened.faux.setResponses([call(name, {}, name), fauxAssistantMessage('Done.')])
        const stream = yield* Effect.promise(() =>
          streamSdk(
            opened.harness,
            { conversationId: opened.root.id, content: 'Run', requestId: name },
            context,
          ),
        )
        const result = yield* consumeReadable(stream, Option.none())
        expect(result.message.parts.find((part) => part.type === `tool-${name}`)).toMatchObject({
          output: 'done',
        })
      }),
    )

/** Inherited answer/approval declarations have no authority; a named own false still overrides SDK approval. */
for (const name of ['constructor', '__proto__'])
  it.live(`ignores inherited policies and accepts an own answer policy for ${name}`, () =>
    Effect.gen(function* () {
      const answers: Record<string, 'wait' | 'later'> = {}
      const approval: Record<string, boolean> = {}
      Object.setPrototypeOf(answers, { [name]: 'later' })
      Object.setPrototypeOf(approval, { [name]: true })
      const fixture = yield* host(
        { [name]: tool({ inputSchema: z.object({}), outputSchema: z.string() }) },
        { answers, approval },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([call(name, {}, name), fauxAssistantMessage('Answered.')])
      let completed = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onFinish: () => {
          Deferred.doneUnsafe(completed, Effect.void)
        },
        onError: (cause) => {
          Deferred.doneUnsafe(completed, new FixtureFailed({ cause }))
        },
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
      const rows = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
      expect(rows).toHaveLength(1)
      const row = rows[0]
      if (row === undefined) throw new Error('Expected person-answer hold')
      expect(row.kind).toBe('answer')
      completed = yield* Deferred.make<void, FixtureFailed>()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolOutput({ tool: name, toolCallId: name, output: 'yes' })),
      )
      yield* Deferred.await(completed)
      if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
      expect(chat.lastMessage.parts.find((part) => part.type === `tool-${name}`)).toMatchObject({
        output: 'yes',
      })

      const own = yield* host(
        { [name]: tool({ needsApproval: true, inputSchema: z.object({}) }) },
        { answers: { [name]: 'later' }, approval: { [name]: false } },
      )
      const other = yield* own.open()
      other.faux.setResponses([call(name, {}, name), fauxAssistantMessage('Later.')])
      const stream = yield* Effect.promise(() =>
        streamSdk(
          other.harness,
          { conversationId: other.root.id, content: 'Ask later', requestId: name },
          context,
        ),
      )
      const result = yield* consumeReadable(stream, Option.none())
      expect(result.message.parts.find((part) => part.type === `tool-${name}`)).toMatchObject({
        output: { status: 'asked' },
      })
      const held = (yield* Effect.promise(() => waiting(other.harness, other.root.id, context)))[0]
      if (held === undefined) throw new Error('Expected later answer hold')
      other.faux.setResponses([fauxAssistantMessage('Received.')])
      yield* Effect.promise(() =>
        answer(other.harness, other.root.id, { holdId: held.holdId, output: 'yes' }, context),
      )
    }),
  )

/** A misspelt safety option must fail registration rather than silently leave a tool ungated. */
for (const option of ['approval', 'answers', 'replay', 'sequential'] as const)
  it.live(`refuses an unknown ${option} tool name`, () =>
    Effect.gen(function* () {
      const options: ToolsOptions = {
        approval: option === 'approval' ? { typo: true } : {},
        answers: option === 'answers' ? { typo: 'wait' as const } : {},
        replay: option === 'replay' ? { typo: 'safe' as const } : {},
        sequential: option === 'sequential' ? ['typo'] : [],
      }
      const failure = yield* Effect.flip(
        toolsExtension(
          'options',
          { pay: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('paid') }) },
          options,
        ),
      )
      expect(failure).toBeInstanceOf(ToolSchemaFailed)
      expect(failure).toMatchObject({ toolName: 'typo' })
      expect(failure.message).toContain(option)
    }),
  )

/** ToolScope is the default context, not an implicit resolver for an SDK context contract. */
it.live('refuses contextSchema without a context resolver at registration', () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      toolsExtension(
        'context',
        {
          scoped: tool({
            inputSchema: z.object({}),
            contextSchema: z.object({ owner: z.string() }),
            execute: () => Promise.resolve('unused'),
          }),
        },
        {},
      ),
    )
    expect(failure).toBeInstanceOf(ToolSchemaFailed)
    expect(failure).toMatchObject({ toolName: 'scoped' })
    expect(failure.message).toContain('context resolver')
  }),
)
