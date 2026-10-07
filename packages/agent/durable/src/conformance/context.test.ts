import { Deferred, Effect, Option, Schema } from 'effect'
import { runForPi } from '../pi.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool, isToolUIPart, type ToolSet } from 'ai'
import { PlainChat } from '../fixtures/chat.ts'
import { expect, it } from '@effect/vitest'
import { z } from 'zod'
import { attachRun, streamRun } from '../main.ts'
import {
  toolsExtension as coreToolsExtension,
  type ToolsOptions as CoreToolsOptions,
} from '../core.ts'
import { call, context, host, texts } from './fixtures/host.ts'
/** Child IPC carries durable numeric identities; NaN and infinities are invalid scope ids. */
const decodeScope = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      conversationId: Schema.Finite,
      taskId: Schema.Finite,
      callId: Schema.String,
      toolName: Schema.String,
    }),
  ),
)
/** Concurrent conversations rendezvous inside execution, so a latest-request closure cannot pass. */
it.live('gives concurrent calls their own durable scope', () =>
  Effect.gen(function* () {
    const both = yield* Deferred.make<void>()
    const scopes: {
      conversationId: number
      taskId: number
      callId: string
      toolName: string
    }[] = []
    const fixture = yield* host(
      {
        scope: tool({
          inputSchema: z.object({}),
          contextSchema: z.object({
            conversationId: z.number(),
            taskId: z.number(),
            callId: z.string(),
            toolName: z.string(),
          }),
          execute: (_input, options) =>
            runForPi(
              Effect.gen(function* () {
                scopes.push(options.context)
                if (scopes.length === 2) Deferred.doneUnsafe(both, Effect.void)
                yield* Deferred.await(both)
                return options.context
              }),
              undefined,
            ),
        }),
      },
      { context: (scope) => scope },
    )
    const opened = yield* fixture.open()
    // Failure before both admissions must still release the rendezvous before closing the host.
    yield* Effect.addFinalizer(() => Deferred.succeed(both, undefined))

    const second = yield* Effect.promise(() =>
      opened.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        },
        context,
      ),
    )
    opened.faux.setResponses([
      call('scope', {}, 'one'),
      call('scope', {}, 'two'),
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Done.'),
    ])
    const one = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'One', requestId: 'one' },
        context,
      ),
    )
    const two = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: second.id, content: 'Two', requestId: 'two' },
        context,
      ),
    )
    yield* Effect.all([consumeReadable(one, Option.none()), consumeReadable(two, Option.none())], {
      concurrency: 'unbounded',
    })
    expect(
      scopes.map((scope) => scope.conversationId).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([opened.root.id, second.id].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(scopes.map((scope) => scope.toolName)).toEqual(['scope', 'scope'])
    expect(new Set(scopes.map((scope) => scope.taskId)).size).toBe(2)
    expect(
      scopes.map((scope) => scope.callId).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(['one', 'two'])
  }),
)
/** Resolver failures and SDK validation failures become model-visible tool errors before execution. */
it.live.each(['resolver', 'schema'] as const)('continues after a %s context failure', (kind) =>
  Effect.gen(function* () {
    let executions = 0
    let resolutions = 0
    const fixture = yield* host(
      {
        scoped: tool({
          inputSchema: z.object({}),
          contextSchema: z.object({ owner: z.string() }),
          execute: () => {
            executions++
            return Promise.resolve('unexpected')
          },
        }),
      },
      {
        context: () => {
          resolutions++
          if (kind === 'resolver') throw new Error('owner unavailable')
          return { owner: 123 }
        },
      },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('scoped', {}, kind),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: 'toolResult',
          isError: true,
          content: [{ type: 'text', text: expect.stringContaining('scoped') }],
        })
        return fauxAssistantMessage('Recovered.')
      },
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: kind },
          context,
        ),
      ),
      Option.none(),
    )
    expect(executions).toBe(0)
    expect(resolutions).toBe(1)
    expect(texts(result.message)).toEqual(['Recovered.'])
    expect(result.message.parts.find((part) => part.type === 'tool-scoped')).toMatchObject({
      state: 'output-error',
    })
  }),
)
/** Schema transformations must reach execute, rather than merely checking and retaining the raw value. */
it.live('validates and transforms resolved context once per execution', () =>
  Effect.gen(function* () {
    let resolutions = 0
    const fixture = yield* host(
      {
        scoped: tool({
          inputSchema: z.object({}),
          contextSchema: z.object({ owner: z.string().transform((value) => value.toUpperCase()) }),
          execute: (_input, options) => Promise.resolve(options.context),
        }),
      },
      {
        context: (scope) => {
          resolutions++
          return { owner: `owner-${scope.conversationId}` }
        },
      },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('scoped', {}, 'scope'), fauxAssistantMessage('Done.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'transform' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.message.parts.find((part) => part.type === 'tool-scoped')).toMatchObject({
      output: { owner: `OWNER-${opened.root.id}` },
    })
    expect(resolutions).toBe(1)
  }),
)
/** A killed process loses closures, but replay must retain all four identities recorded at intent. */
it.live('preserves ToolScope after process death and safe replay', () =>
  Effect.gen(function* () {
    const seen: unknown[] = []
    const fixture = yield* host(
      {
        scope: tool({
          inputSchema: z.object({}),
          execute: (_input, options) => {
            seen.push(options.context)
            return Promise.resolve(options.context)
          },
        }),
      },
      { replay: { scope: 'safe' } },
    )
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL('./fixtures/toolscrash.mjs', import.meta.url)), fixture.file],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = NodeEvents.EventEmitter.once(child, 'exit')
        child.kill('SIGKILL')
        yield* Effect.promise(() => exited)
      }),
    )
    const [data] = yield* Effect.promise(() => NodeEvents.EventEmitter.once(child.stdout, 'data'))
    if (!Buffer.isBuffer(data)) throw new Error('Expected scope signal')
    const scope = decodeScope(data.toString())
    const exited = NodeEvents.EventEmitter.once(child, 'exit')
    child.kill('SIGKILL')
    yield* Effect.promise(() => exited)
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Recovered.')])
    const attached = yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))
    if (attached.status === 'idle') throw new Error('Expected interrupted run')
    opened.harness.resume()
    const result = yield* consumeReadable(attached.stream, Option.none())
    expect(seen).toEqual([scope])
    expect(result.message.parts.find((part) => part.type === 'tool-scope')).toMatchObject({
      output: scope,
    })
  }),
)
/** Install an Effect registration into the real harness without routing it through the Promise facade. */
const coreHost = Effect.fn('Conformance.coreContextHost')(function* (
  tools: ToolSet,
  options: CoreToolsOptions,
) {
  const fixture = yield* host({}, {})
  const extension = yield* coreToolsExtension('context', tools, options)
  return yield* fixture.open([extension])
})
/** Incorrect Effect-entry callback results must not escape as unnamed fiber defects or double prefixes. */
for (const sample of [
  {
    name: 'plain value',
    resolve: () => ({ owner: 'person' }),
    diagnostic: 'Context resolver must return an Effect',
  },
  {
    name: 'Promise value',
    resolve: () => Promise.resolve({ owner: 'person' }),
    diagnostic: 'Context resolver must return an Effect',
  },
  {
    name: 'rejected Promise',
    resolve: () => Promise.reject(new Error('invalid resolver rejection')),
    diagnostic: 'Context resolver must return an Effect',
  },
  {
    name: 'synchronous throw',
    resolve: () => {
      throw new Error('resolver sync boom')
    },
    diagnostic: 'resolver sync boom',
  },
  {
    name: 'Effect defect',
    resolve: () => Effect.die(new Error('resolver died')),
    diagnostic: 'resolver died',
  },
])
  it.live(`reports ${sample.name} from a context resolver as one named tool error`, () =>
    Effect.gen(function* () {
      let executions = 0
      const opened = yield* coreHost(
        {
          scoped: tool({
            inputSchema: z.object({}),
            execute: () => {
              executions++
              return Promise.resolve('unexpected')
            },
          }),
        },
        {
          // Deliberately exercise the runtime SDK boundary with a caller that violates this entry's type.
          // @ts-expect-error Effect entry does not accept plain values or Promises.
          context: sample.resolve,
        },
      )
      opened.faux.setResponses([
        call('scoped', {}, 'invalid-context'),
        (request) => {
          expect(request.messages.at(-1)).toMatchObject({
            role: 'toolResult',
            isError: true,
            content: [
              {
                type: 'text',
                text: `<harness>\n[error] Tool scoped context failed: ${sample.diagnostic}\n</harness>`,
              },
            ],
          })
          return fauxAssistantMessage('Recovered.')
        },
      ])
      const result = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Try', requestId: sample.name },
            context,
          ),
        ),
        Option.none(),
      )
      expect(result.message.parts.find((part) => part.type === 'tool-scoped')).toMatchObject({
        state: 'output-error',
        errorText: `<harness>\n[error] Tool scoped context failed: ${sample.diagnostic}\n</harness>`,
      })
      expect(executions).toBe(0)
      expect(texts(result.message)).toEqual(['Recovered.'])
    }),
  )
/** Promise hosts must retain the SDK's value-or-Promise context resolver contract. */
it.live.each(['value', 'promise'] as const)(
  'converts a Promise-entry %s context resolver once',
  (kind) =>
    Effect.gen(function* () {
      let resolutions = 0
      const fixture = yield* host(
        {
          scoped: tool({
            inputSchema: z.object({}),
            contextSchema: z.object({ owner: z.string() }),
            execute: (_input, options) => Promise.resolve(options.context),
          }),
        },
        {
          context: (scope) => {
            resolutions++
            const value = { owner: `owner-${scope.conversationId}` }
            return kind === 'value' ? value : Promise.resolve(value)
          },
        },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('scoped', {}, 'scope'), fauxAssistantMessage('Done.')])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Scope' }))
      if (chat.lastMessage === undefined) throw new Error('Expected assistant')
      expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
        state: 'output-available',
        output: { owner: `owner-${opened.root.id}` },
      })
      expect(resolutions).toBe(1)
    }),
)
