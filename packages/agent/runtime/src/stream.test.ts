import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { defineTool, init, useModel, useTool } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import { createAgentRouter } from '@flue/runtime/routing'
import {
  createFlueClient,
  type AgentConversationObservationSnapshot,
  type ConversationStreamChunk,
  type FlueConversationMessage,
} from '@flue/sdk'
import { textOf } from '@vivid/contracts'
import { Effect, Option, Queue, Stream } from 'effect'
import * as v from 'valibot'
import { testDatabaseConfigured } from '../../../../apps/server/src/database/testdb.ts'
import { disposableStorage } from '../tests/schema.ts'

/** The public runtime owns projection; the test controls only the provider's content events. */
function Reply() {
  useModel('fixture/text')
  useTool(
    defineTool({
      name: 'lookup',
      description: 'Return a fixture tool result.',
      input: v.object({}),
      /** The public tool executor persists this output between the two model steps. */
      run: () => ({ output: { answer: 'found' } }),
    }),
  )
  return 'Reply with the supplied content.'
}
Reply.agentName = 'reply'

/** A public observation notification, rather than a timer, acknowledges each transport milestone. */
const observed = (
  states: Queue.Queue<AgentConversationObservationSnapshot>,
  accepts: (state: AgentConversationObservationSnapshot) => boolean,
) =>
  Stream.fromQueue(states).pipe(
    Stream.filter(accepts),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

/**
 * Hono's in-process fetch does not abort response reads like network fetch. Couple the body to
 * the request signal so SDK cancellation cannot leave a stream reconnecting after Flue stops.
 */
function fetchRuntime(router: ReturnType<typeof createAgentRouter>): typeof fetch {
  return (input, options) => {
    const request = new Request(input, options)
    request.signal.throwIfAborted()
    return Promise.resolve(router.fetch(request)).then((response) => {
      request.signal.throwIfAborted()
      if (response.body === null) return response
      return new Response(
        response.body.pipeThrough(new TransformStream(), { signal: request.signal }),
        response,
      )
    })
  }
}

/** Reproduce the provider's content indexes before Flue translates them into UI chunks. */
function sequence(distinct: boolean) {
  const message = fauxAssistantMessage(
    distinct
      ? [
          { type: 'text', text: 'First is done.' },
          { type: 'thinking', thinking: '.' },
          { type: 'text', text: 'Next topic begins.' },
        ]
      : [
          { type: 'text', text: '**Why Rivers Meander**' },
          { type: 'thinking', thinking: '.' },
        ],
  )
  const events: AssistantMessageEvent[] = [
    { type: 'start', partial: message },
    { type: 'text_start', contentIndex: 0, partial: message },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: distinct ? 'First is done.' : '**',
      partial: message,
    },
  ]
  if (distinct)
    events.push({ type: 'text_end', contentIndex: 0, content: 'First is done.', partial: message })
  events.push(
    { type: 'thinking_start', contentIndex: 1, partial: message },
    { type: 'thinking_delta', contentIndex: 1, delta: '.', partial: message },
    { type: 'thinking_end', contentIndex: 1, content: '.', partial: message },
  )
  if (distinct) {
    events.push(
      { type: 'text_start', contentIndex: 2, partial: message },
      { type: 'text_delta', contentIndex: 2, delta: 'Next topic begins.', partial: message },
      { type: 'text_end', contentIndex: 2, content: 'Next topic begins.', partial: message },
    )
  } else {
    events.push(
      { type: 'text_delta', contentIndex: 0, delta: 'Why Rivers Meander**', partial: message },
      { type: 'text_end', contentIndex: 0, content: '**Why Rivers Meander**', partial: message },
    )
  }
  events.push({ type: 'done', reason: 'stop', message })
  return events
}

/** A completed tool step forces the next model step to reuse the response's original message id. */
function toolSequence(): AssistantMessageEvent[] {
  const call = { type: 'toolCall', id: 'lookup-1', name: 'lookup', arguments: {} } as const
  const message = fauxAssistantMessage([call], { stopReason: 'toolUse' })
  return [
    { type: 'start', partial: message },
    { type: 'toolcall_start', contentIndex: 0, partial: message },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: message },
    { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message },
    { type: 'done', reason: 'toolUse', message },
  ]
}

/** Real storage and runtime; only the provider's three ordered streams are test controlled. */
const fixture = Effect.fn('FlueStream.fixture')(function* () {
  const { storage } = yield* disposableStorage
  const history = createAssistantMessageEventStream()
  const tool = createAssistantMessageEventStream()
  const answer = createAssistantMessageEventStream()
  const pending = [history, tool, answer]
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'text' }] })
  const stream = () => {
    const next = pending.shift()
    if (next === undefined) expect.fail('The provider received an unexpected fourth call')
    return next
  }
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      start({
        agents: [Reply],
        db: storage,
        providers: [{ ...faux.provider, stream, streamSimple: stream }],
      }),
    ),
    (runtime) => Effect.promise(() => runtime.stop()),
  )
  // Failed assertions must release every pending provider before stop drains active work.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const source of [history, tool, answer]) source.end(fauxAssistantMessage('stopped'))
    }),
  )
  for (const event of sequence(false)) history.push(event)
  const id = NodeCrypto.randomUUID()
  const instance = init(Reply, { id })
  const earlier = yield* Effect.tryPromise(() => instance.dispatch('An older reply'))
  yield* Effect.tryPromise(() => instance.read(earlier.submissionId))
  const client = createFlueClient({
    url: `http://runtime.test/${id}`,
    fetch: fetchRuntime(createAgentRouter(Reply)),
  })
  return { client, tool, answer }
})

/** Wire consumers receive only the current response, before its completion and settlement markers. */
function replacements(chunks: readonly ConversationStreamChunk[], live: FlueConversationMessage) {
  expect(chunks.filter((chunk) => chunk.type === 'conversation-reset')).toEqual([])
  const messages = chunks.filter((chunk) => chunk.type === 'message-appended')
  expect(messages.every((chunk) => chunk.message.submissionId === live.submissionId)).toBe(true)
  const appended = messages.filter((chunk) => chunk.message.role === 'assistant')
  expect(appended).toHaveLength(2)
  expect(appended.map((chunk) => chunk.message.id)).toEqual([live.id, live.id])
  const [first, second] = appended
  if (first === undefined || second === undefined)
    expect.fail('Both completed steps must replace the response')
  expect(first.message.parts).toEqual([
    {
      type: 'dynamic-tool',
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      input: {},
      state: 'input-available',
    },
  ])
  expect(second.message).toEqual(live)
  const started = chunks.filter((chunk) => chunk.type === 'message-started')
  expect(started.map((chunk) => chunk.messageId)).toEqual([live.id, live.id])
  const completed = chunks.filter((chunk) => chunk.type === 'message-completed')
  expect(completed).toHaveLength(2)
  for (const completion of completed) {
    const before = chunks[chunks.indexOf(completion) - 1]
    if (before === undefined || before.type !== 'message-appended')
      expect.fail('Each completion must immediately follow its replacement')
    expect(before.position.batch).toBe(completion.position.batch)
  }
  const settlement = chunks.findIndex((chunk) => chunk.type === 'submission-settled')
  const lastCompletion = completed.at(-1)
  if (lastCompletion === undefined) expect.fail('The Run must complete a model step')
  expect(settlement).toBeGreaterThan(chunks.indexOf(lastCompletion))
  expect(live.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
    state: 'output-available',
    output: { answer: 'found' },
  })
}

describe.skipIf(!testDatabaseConfigured)('Flue live reply reconciliation', () => {
  for (const distinct of [false, true]) {
    it.live.each(['sse', 'long-poll'] as const)(
      distinct
        ? 'keeps distinct text blocks separated by thinking as two paragraphs via %s'
        : 'reconciles text, thinking, and text from the same block to one text part via %s',
      (transport) =>
        Effect.gen(function* () {
          const { client, tool, answer } = yield* fixture()
          const receipt = yield* Effect.tryPromise(() =>
            client.send({ message: { kind: 'user', body: 'reply' } }),
          )
          const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
          const observation = yield* Effect.acquireRelease(
            Effect.sync(() => client.observe({ live: transport, limit: 1 })),
            (value) => Effect.sync(() => value.close()),
          )
          const changed = () => {
            Queue.offerUnsafe(states, observation.getSnapshot())
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => observation.subscribe(changed)),
            (unsubscribe) => Effect.sync(unsubscribe),
          )
          changed()
          const ready = yield* observed(states, (state) => state.phase === 'live')
          const offset = ready.offset
          if (offset === undefined) expect.fail('The live observer must have an offset')
          for (const event of toolSequence()) tool.push(event)
          const streaming = yield* observed(
            states,
            (state) =>
              state.conversation !== undefined &&
              state.conversation.messages.some(
                (message) =>
                  message.submissionId === receipt.submissionId &&
                  message.parts.some(
                    (part) => part.type === 'dynamic-tool' && part.state === 'output-available',
                  ),
              ),
          )
          const streamingConversation = streaming.conversation
          if (streamingConversation === undefined)
            expect.fail('The first step must have an observed conversation')
          const response = streamingConversation.messages.find(
            (message) =>
              message.role === 'assistant' && message.submissionId === receipt.submissionId,
          )
          if (response === undefined) expect.fail('The first step must have a response id')
          for (const event of sequence(distinct)) answer.push(event)
          const completed = yield* observed(
            states,
            (state) =>
              state.conversation !== undefined &&
              state.conversation.settlements.some(
                (settled) => settled.submissionId === receipt.submissionId,
              ),
          )
          const conversation = completed.conversation
          if (conversation === undefined) expect.fail('The observed conversation must exist')
          const live = conversation.messages.find((message) => message.id === response.id)
          const stored = yield* Effect.tryPromise(() => client.history())
          const canonical = stored.messages.find((message) => message.id === response.id)
          if (live === undefined || canonical === undefined)
            expect.fail(
              'The completed reply must retain its first-step id in observation and history',
            )
          expect(live.parts).toEqual(canonical.parts)
          expect(live.parts.filter((part) => part.type === 'text')).toHaveLength(distinct ? 2 : 1)
          expect(textOf(live)).toBe(
            distinct ? 'First is done.\n\nNext topic begins.' : '**Why Rivers Meander**',
          )
          const chunks: ConversationStreamChunk[] = []
          yield* Effect.tryPromise(() =>
            client.wait(
              { ...receipt, offset },
              {
                onEvent: (chunk) => {
                  chunks.push(chunk)
                },
              },
            ),
          )
          replacements(chunks, live)
        }).pipe(Effect.scoped),
    )
  }
})
