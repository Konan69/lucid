import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type ProviderStreams,
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
import { Effect, Fiber, Option, Queue, Stream } from 'effect'
import * as v from 'valibot'
import { disposableStorage, testDatabaseConfigured } from '../tests/schema.ts'

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
const observed = <Value>(states: Queue.Queue<Value>, accepts: (state: Value) => boolean) =>
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
const fixture = Effect.fn('FlueStream.fixture')(function* (ending: 'Continue' | 'Terminate') {
  const { storage } = yield* disposableStorage
  const requested = yield* Queue.unbounded<void>()
  const cancelled = yield* Queue.unbounded<void>()
  const history = createAssistantMessageEventStream()
  const tool = createAssistantMessageEventStream()
  const answer = createAssistantMessageEventStream()
  const pending = [history, tool, answer]
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'text' }] })
  const stream: ProviderStreams['stream'] = (_model, _context, options) => {
    const next = pending.shift()
    if (next === undefined) expect.fail('The provider received an unexpected fourth call')
    // The controlled provider must honor the same request abort signal as a real gateway.
    if (options !== undefined && options.signal !== undefined) {
      const cancel = () => {
        Queue.offerUnsafe(cancelled, undefined)
        next.push({
          type: 'error',
          reason: 'aborted',
          error: fauxAssistantMessage('stopped', { stopReason: 'aborted' }),
        })
      }
      if (options.signal.aborted) cancel()
      else options.signal.addEventListener('abort', cancel, { once: true })
    }
    Queue.offerUnsafe(requested, undefined)
    return next
  }
  /** A terminating tool has no following model answer to trigger reconciliation. */
  function Ending() {
    useModel('fixture/text')
    useTool(
      defineTool({
        name: 'lookup',
        description: 'Return a result and finish this response.',
        input: v.object({}),
        run: () => ({ output: { answer: 'found' }, terminate: true }),
      }),
    )
    return 'Read the result and finish.'
  }
  Ending.agentName = 'ending'
  const agent = ending === 'Terminate' ? Ending : Reply
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      start({
        agents: [agent],
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
  const instance = init(agent, { id })
  const earlier = yield* Effect.tryPromise(() => instance.dispatch('An older reply'))
  yield* Effect.tryPromise(() => instance.read(earlier.submissionId))
  yield* Queue.take(requested)
  const client = createFlueClient({
    url: `http://runtime.test/${id}`,
    fetch: fetchRuntime(createAgentRouter(agent)),
  })
  return {
    client,
    tool,
    answer,
    instance,
    called: () => Queue.take(requested),
    aborted: () => Queue.take(cancelled),
  }
})

/** Wire consumers receive one canonical response immediately before its first settlement. */
function replacements(
  chunks: readonly ConversationStreamChunk[],
  live: FlueConversationMessage,
  steps: number,
) {
  expect(chunks.filter((chunk) => chunk.type === 'conversation-reset')).toEqual([])
  const messages = chunks.filter((chunk) => chunk.type === 'message-appended')
  const appended = messages.filter((chunk) => chunk.message.role === 'assistant')
  expect(appended.every((chunk) => chunk.message.submissionId === live.submissionId)).toBe(true)
  expect(appended).toHaveLength(1)
  expect(appended.map((chunk) => chunk.message.id)).toEqual([live.id])
  const [replacement] = appended
  if (replacement === undefined) expect.fail('Settlement must reconcile the completed response')
  expect(replacement.message).toEqual(live)
  const started = chunks.filter((chunk) => chunk.type === 'message-started')
  expect(started.map((chunk) => chunk.messageId)).toEqual(
    Array.from({ length: steps }, () => live.id),
  )
  const completed = chunks.filter((chunk) => chunk.type === 'message-completed')
  expect(completed).toHaveLength(steps)
  const settlement = chunks.findIndex((chunk) => chunk.type === 'submission-settled')
  const before = chunks[settlement - 1]
  const settled = chunks[settlement]
  if (before === undefined || settled === undefined)
    expect.fail('The completed Run must have a replacement before settlement')
  if (before.type !== 'message-appended' || settled.type !== 'submission-settled')
    expect.fail('The terminal batch must contain the response upsert and settlement')
  expect(before).toEqual(replacement)
  expect(before.position.batch).toBe(settled.position.batch)
  const lastCompletion = completed.at(-1)
  if (lastCompletion === undefined) expect.fail('The Run must complete a model step')
  expect(chunks.indexOf(replacement)).toBeGreaterThan(chunks.indexOf(lastCompletion))
  expect(live.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
    state: 'output-available',
    output: { answer: 'found' },
  })
}

/** One public event queue acknowledges model progress without sleeps or scheduler guesses. */
const recording = Effect.fn('FlueStream.recording')(function* () {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (value) => Effect.sync(() => value.abort()),
  )
  const events = yield* Queue.unbounded<ConversationStreamChunk>()
  const chunks: ConversationStreamChunk[] = []
  return {
    chunks,
    signal: controller.signal,
    onEvent: (chunk: ConversationStreamChunk) => {
      chunks.push(chunk)
      Queue.offerUnsafe(events, chunk)
    },
    next: (accepts: (chunk: ConversationStreamChunk) => boolean) => observed(events, accepts),
  }
})

describe.skipIf(!testDatabaseConfigured)('Flue live reply reconciliation', () => {
  for (const distinct of [false, true]) {
    it.live.each(['sse', 'long-poll'] as const)(
      distinct
        ? 'keeps distinct text blocks separated by thinking as two paragraphs via %s'
        : 'reconciles text, thinking, and text from the same block to one text part via %s',
      (transport) =>
        Effect.gen(function* () {
          const { client, tool, answer } = yield* fixture('Continue')
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
          expect(live).toEqual(canonical)
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
          replacements(chunks, live, 2)
        }).pipe(Effect.scoped),
    )
  }
  it.live(
    'reconciles once before the first joined settlement and does not resend for the host',
    () =>
      Effect.gen(function* () {
        const { client, tool, answer, instance, called } = yield* fixture('Continue')
        const receipt = yield* Effect.tryPromise(() =>
          client.send({ message: { kind: 'user', body: 'host' } }),
        )
        const wire = yield* recording()
        const read = yield* Effect.tryPromise(() =>
          client.wait(receipt, { onEvent: wire.onEvent, signal: wire.signal }),
        ).pipe(Effect.forkScoped)
        yield* called()
        const joined = yield* Effect.tryPromise(() =>
          instance.dispatch('Joined during the held model step'),
        )
        for (const event of toolSequence()) tool.push(event)
        for (const event of sequence(false)) answer.push(event)
        yield* Fiber.join(read)
        const history = yield* Effect.tryPromise(() => client.history())
        const canonical = history.messages.find(
          (message) =>
            message.role === 'assistant' && message.submissionId === receipt.submissionId,
        )
        if (canonical === undefined) expect.fail('The host response must remain in history')
        replacements(wire.chunks, canonical, 2)
        const settlements = wire.chunks.filter((chunk) => chunk.type === 'submission-settled')
        expect(settlements.map((chunk) => chunk.submissionId)).toEqual([
          joined.submissionId,
          receipt.submissionId,
        ])
        expect(settlements.map((chunk) => chunk.answeredBySubmissionId)).toEqual([
          receipt.submissionId,
          receipt.submissionId,
        ])
        expect((yield* Effect.tryPromise(() => instance.read(joined))).text).toBe(textOf(canonical))
      }).pipe(Effect.scoped),
  )

  it.live('reconciles an aborted partial reply before publishing the aborted settlement', () =>
    Effect.gen(function* () {
      const { client, tool, answer, called, aborted } = yield* fixture('Continue')
      const receipt = yield* Effect.tryPromise(() =>
        client.send({ message: { kind: 'user', body: 'stop midway' } }),
      )
      const wire = yield* recording()
      // An aborted SDK wait rejects; history and wire outcomes below establish the typed verdict.
      const read = yield* Effect.tryPromise(() =>
        client.wait(receipt, { onEvent: wire.onEvent, signal: wire.signal }),
      ).pipe(Effect.result, Effect.forkScoped)
      yield* called()
      for (const event of toolSequence()) tool.push(event)
      yield* called()
      for (const event of sequence(false).slice(0, -1)) answer.push(event)
      yield* wire.next(
        (chunk) => chunk.type === 'message-delta' && chunk.delta === 'Why Rivers Meander**',
      )
      expect(yield* Effect.tryPromise(() => client.abort())).toEqual({ aborted: true })
      yield* aborted()
      yield* Fiber.join(read)
      const history = yield* Effect.tryPromise(() => client.history())
      const settled = history.settlements.find(
        (value) => value.submissionId === receipt.submissionId,
      )
      if (settled === undefined) expect.fail('The aborted submission must settle')
      expect(settled.outcome).toBe('aborted')
      const canonical = history.messages.find(
        (message) => message.role === 'assistant' && message.submissionId === receipt.submissionId,
      )
      if (canonical === undefined) expect.fail('Aborting must retain the partial response')
      replacements(wire.chunks, canonical, 2)
      expect(textOf(canonical)).toBe('**Why Rivers Meander**')
    }).pipe(Effect.scoped),
  )

  it.live('reconciles after a terminating tool when no final model step follows it', () =>
    Effect.gen(function* () {
      const { client, tool, called } = yield* fixture('Terminate')
      const receipt = yield* Effect.tryPromise(() =>
        client.send({ message: { kind: 'user', body: 'finish with the tool' } }),
      )
      const wire = yield* recording()
      const read = yield* Effect.tryPromise(() =>
        client.wait(receipt, { onEvent: wire.onEvent, signal: wire.signal }),
      ).pipe(Effect.forkScoped)
      yield* called()
      for (const event of toolSequence()) tool.push(event)
      yield* Fiber.join(read)
      const history = yield* Effect.tryPromise(() => client.history())
      const canonical = history.messages.find(
        (message) => message.role === 'assistant' && message.submissionId === receipt.submissionId,
      )
      if (canonical === undefined)
        expect.fail('The terminating tool response must remain in history')
      replacements(wire.chunks, canonical, 1)
      expect(textOf(canonical)).toBe('')
      const settled = history.settlements.find(
        (value) => value.submissionId === receipt.submissionId,
      )
      if (settled === undefined) expect.fail('The terminating tool submission must settle')
      expect(settled.outcome).toBe('completed')
    }).pipe(Effect.scoped),
  )
})
