import { describe, expect, it } from '@effect/vitest'
import {
  createAssistantMessageEventStream,
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Context,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { Cause, ConfigProvider, Effect, Exit, Fiber, Queue, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { modelStream } from './policy.ts'

/** The fixture supplies provider events through the real SDK stream, beneath the policy under test. */
const model = (id: string): Model<'openai-completions'> => ({
  id,
  name: id,
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
})
/** A rejected pull exercises the SDK exception seam without replacing class prototype methods. */
class RejectedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(private readonly defect: Error) {
    super(
      () => false,
      () => message('primary', [], 'error'),
    )
  }
  override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return { next: () => Promise.reject(this.defect) }
  }
}

const primary = model('primary')
const fallback = model('fallback')

/** Explicit SDK messages retain the real start/done/error protocol and mutable stream semantics. */
const message = (
  selected: string,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'openrouter',
  model: selected,
  stopReason,
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
})

/** An empty start precedes either a content-bearing answer or an empty successful completion. */
const answer = (selected: string, text: string): AssistantMessageEvent[] => {
  const initial = message(selected, [], 'pending')
  const final = message(selected, text.length === 0 ? [] : [{ type: 'text', text }], 'stop')
  return [
    { type: 'start', partial: initial },
    { type: 'done', reason: 'stop', message: final },
  ]
}

/** This script is the test provider dependency; retry order, buffering, and deadline remain production code. */
const fixture = Effect.fn('Models.test.fixture')(function* (
  plans: ReadonlyArray<ReadonlyArray<AssistantMessageEvent>>,
) {
  const calls = yield* Queue.unbounded<string>()
  const signals: AbortSignal[] = []
  const sources: ReturnType<typeof createAssistantMessageEventStream>[] = []
  let index = 0
  const provider = {
    ...openrouterProvider(),
    getModels: () => [primary, fallback],
    streamSimple: (
      selected: Model<'openai-completions'>,
      _context: Context,
      options: SimpleStreamOptions = {},
    ) => {
      if (options.signal === undefined) expect.fail('Every attempt needs an abort signal')
      signals.push(options.signal)
      Queue.offerUnsafe(calls, selected.id)
      const source = createAssistantMessageEventStream()
      sources.push(source)
      const plan = plans[index]
      index += 1
      if (plan === undefined) expect.fail('Unexpected model attempt')
      for (const event of plan) source.push(event)
      return source
    },
  }
  return { provider, calls, sources, signals }
})

const configuration = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))

describe('bounded model policy', () => {
  it.effect('retries 429 twice, then falls through in order without emitting failed starts', () =>
    Effect.gen(function* () {
      const failure = { ...message('primary', [], 'error'), errorMessage: '429 Too Many Requests' }
      const rejected: AssistantMessageEvent[] = [
        { type: 'start', partial: failure },
        { type: 'error', reason: 'error', error: failure },
      ]
      const evidence = yield* fixture([rejected, rejected, rejected, answer('fallback', 'Hello')])
      const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      )
      expect(yield* Queue.take(evidence.calls)).toBe('primary')
      yield* TestClock.adjust('250 millis')
      expect(yield* Queue.take(evidence.calls)).toBe('primary')
      yield* TestClock.adjust('500 millis')
      expect(yield* Queue.take(evidence.calls)).toBe('primary')
      expect(yield* Queue.take(evidence.calls)).toBe('fallback')
      const events = yield* Fiber.join(run)
      expect(events.map((event) => event.type)).toEqual(['start', 'done'])
      expect(
        events.filter((event) => event.type === 'done').map((event) => event.message.model),
      ).toEqual(['fallback'])
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_FALLBACKS: 'openrouter/fallback' }))),
  )

  it.effect('empty successful completions exhaust the bounded schedule as NoAnswer', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture([
        answer('primary', ''),
        answer('primary', ''),
        answer('primary', ''),
      ])
      const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.exit,
        Effect.forkScoped,
      )
      yield* Queue.take(evidence.calls)
      yield* TestClock.adjust('250 millis')
      yield* Queue.take(evidence.calls)
      yield* TestClock.adjust('500 millis')
      yield* Queue.take(evidence.calls)
      const ended = yield* Fiber.join(run)
      expect(Exit.isFailure(ended)).toBe(true)
      if (Exit.isFailure(ended)) expect(String(ended.cause)).toContain('NoAnswer')
    }).pipe(Effect.provide(configuration({}))),
  )

  it.effect('an attempt deadline aborts its provider before retrying', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture([
        [{ type: 'start', partial: message('primary', [], 'pending') }],
        answer('primary', 'Hello'),
      ])
      const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Queue.take(evidence.calls)
      const signal = evidence.signals[0]
      if (signal === undefined) expect.fail('A provider signal is required')
      expect(signal.aborted).toBe(false)
      yield* TestClock.adjust('1 second')
      expect(signal.aborted).toBe(true)
      yield* TestClock.adjust('250 millis')
      yield* Queue.take(evidence.calls)
      const events = yield* Fiber.join(run)
      expect(events.map((event) => event.type)).toEqual(['start', 'done'])
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_ATTEMPT_TIMEOUT_MS: '1000' }))),
  )

  it.effect('one overall deadline fails a provider that never produces content', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture([
        [{ type: 'start', partial: message('primary', [], 'pending') }],
      ])
      const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.exit,
        Effect.forkScoped,
      )
      yield* Queue.take(evidence.calls)
      yield* TestClock.adjust('90 seconds')
      const ended = yield* Fiber.join(run)
      expect(Exit.isFailure(ended)).toBe(true)
      if (Exit.isFailure(ended)) expect(String(ended.cause)).toContain('TimedOut')
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_ATTEMPT_TIMEOUT_MS: '100000' }))),
  )

  it.effect(
    'first content disables the overall deadline and prevents replay of a later failure',
    () =>
      Effect.gen(function* () {
        const final = message('primary', [{ type: 'text', text: 'Hello' }], 'pending')
        const evidence = yield* fixture([
          [
            { type: 'start', partial: final },
            { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial: final },
          ],
        ])
        const received = yield* Queue.unbounded<AssistantMessageEvent>()
        const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
          Stream.tap((event) => Queue.offer(received, event)),
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped,
        )
        yield* Queue.take(evidence.calls)
        yield* Queue.take(received)
        yield* Queue.take(received)
        yield* TestClock.adjust('120 seconds')
        const source = evidence.sources[0]
        if (source === undefined) expect.fail('A provider stream is required')
        source.push({
          type: 'error',
          reason: 'error',
          error: { ...final, stopReason: 'error', errorMessage: '503 unavailable' },
        })
        const ended = yield* Fiber.join(run)
        expect(Exit.isFailure(ended)).toBe(true)
        expect(evidence.sources).toHaveLength(1)
      }).pipe(Effect.provide(configuration({ VIVID_MODEL_FALLBACKS: 'openrouter/fallback' }))),
  )
  it.effect('reasoning-only failures remain buffered through retry and fallback', () =>
    Effect.gen(function* () {
      const thinking = message(
        'primary',
        [{ type: 'thinking', thinking: 'Private reasoning' }],
        'stop',
      )
      const empty: AssistantMessageEvent[] = [
        { type: 'start', partial: thinking },
        { type: 'thinking_delta', contentIndex: 0, delta: 'Private reasoning', partial: thinking },
        { type: 'done', reason: 'stop', message: thinking },
      ]
      const evidence = yield* fixture([empty, empty, empty, answer('fallback', 'Answer')])
      const run = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Queue.take(evidence.calls)
      yield* TestClock.adjust('250 millis')
      yield* Queue.take(evidence.calls)
      yield* TestClock.adjust('500 millis')
      yield* Queue.take(evidence.calls)
      yield* Queue.take(evidence.calls)
      const events = yield* Fiber.join(run)
      expect(events.map((event) => event.type)).toEqual(['start', 'done'])
      expect(JSON.stringify(events)).not.toContain('Private reasoning')
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_FALLBACKS: 'openrouter/fallback' }))),
  )

  it.effect('unknown catalog entries fail configuration before any provider request', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture([])
      const exit = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('ModelConfigurationInvalid')
      expect(evidence.signals).toHaveLength(0)
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_FALLBACKS: 'openrouter/typo' }))),
  )

  it.effect('unexpected iterator rejection stays a defect without retry or fallback', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture([])
      const defect = new TypeError('SDK invariant failed')
      let attempts = 0
      const provider = {
        ...evidence.provider,
        streamSimple: () => {
          attempts += 1
          return new RejectedStream(defect)
        },
      }
      const exit = yield* modelStream(provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(configuration({ VIVID_MODEL_FALLBACKS: 'openrouter/fallback' }))),
  )
  it.effect('authentication refusals require the operator without retrying the same model', () =>
    Effect.gen(function* () {
      const denied = { ...message('primary', [], 'error'), errorMessage: '401 Unauthorized' }
      const evidence = yield* fixture([[{ type: 'error', reason: 'error', error: denied }]])
      const exit = yield* modelStream(evidence.provider, primary, { messages: [] }, {}).pipe(
        Stream.runCollect,
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('ModelUnavailable')
      expect(evidence.signals).toHaveLength(1)
    }).pipe(Effect.provide(configuration({}))),
  )
})
