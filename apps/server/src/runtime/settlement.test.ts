import { describe, expect, it } from '@effect/vitest'
import {
  createFlueClient,
  type AgentConversationObservationSnapshot,
  type FlueConversationState,
  type FlueConversationMessage,
} from '@flue/sdk'
import { RunId } from '@vivid/contracts'
import { Effect, Fiber, Queue } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { observeRun, Settlement } from './settlement.ts'

const runId = RunId.make('run-under-test')

/** A public SDK observation is the runtime dependency; the production classifier and clock stay real. */
const fixture = Effect.fn('Runtime.test.fixture')(function* () {
  const ready = yield* Queue.unbounded<void>()
  const listeners = new Set<() => void>()
  let snapshot: AgentConversationObservationSnapshot = {
    conversation: undefined,
    offset: undefined,
    phase: 'loading',
    error: undefined,
  }
  let closed = false
  let aborted = false
  const client = {
    ...createFlueClient({ url: 'http://127.0.0.1:1' }),
    abort: () => {
      aborted = true
      snapshot = {
        conversation: {
          conversationId: 'conversation',
          messages: [],
          settlements: [{ submissionId: runId, outcome: 'aborted' }],
        },
        offset: '0',
        phase: 'live',
        error: undefined,
      }
      for (const listener of listeners) listener()
      return Promise.resolve({ aborted: true })
    },
    observe: () => ({
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        Queue.offerUnsafe(ready, undefined)
        return () => {
          listeners.delete(listener)
        }
      },
      refresh: () => undefined,
      close: () => {
        closed = true
      },
    }),
  }
  /** Updates carry materialized Messages and settlement evidence, as Flue's public adapter does. */
  const publish = (state: FlueConversationState) => {
    snapshot = { conversation: state, offset: '0', phase: 'live', error: undefined }
    for (const listener of listeners) listener()
  }
  const phase = (value: AgentConversationObservationSnapshot['phase']) => {
    snapshot = { ...snapshot, phase: value }
    for (const listener of listeners) listener()
  }
  /** SDK connection refusal, retryable HTTP failures and stalls all publish this recoverable phase. */
  const disconnect = (error: Error) => {
    snapshot = { ...snapshot, phase: 'connecting', error }
    for (const listener of listeners) listener()
  }
  return { client, ready, publish, phase, disconnect, closed: () => closed, aborted: () => aborted }
})

/** Starts and empty parts alone are deliberately insufficient first-token evidence. */
const assistant = (parts: FlueConversationMessage['parts']): FlueConversationMessage => ({
  id: 'answer',
  role: 'assistant',
  purpose: 'assistant',
  display: 'visible',
  submissionId: runId,
  parts,
})

describe('Run settlement observation', () => {
  it.effect('keeps only the 520 status and classification from a provider settlement', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        messages: [assistant([])],
        settlements: [
          {
            submissionId: runId,
            outcome: 'failed',
            error: {
              type: 'operation_failed',
              meta: { reason: '520 status code (no body)' },
              message: 'private provider prose',
            },
          },
        ],
      })
      expect(yield* Fiber.join(run)).toEqual(
        Settlement.cases.Failed.make({ reason: 'ModelUnavailable', providerStatus: 520 }),
      )
    }),
  )

  it.effect('classifies upstream timeout evidence and closes its observation', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        messages: [assistant([])],
        settlements: [
          {
            submissionId: runId,
            outcome: 'failed',
            error: { meta: { reason: 'Upstream idle timeout exceeded' } },
          },
        ],
      })
      const result = yield* Fiber.join(run)
      expect(result).toEqual(Settlement.cases.Failed.make({ reason: 'TimedOut' }))
      expect(evidence.closed()).toBe(true)
    }),
  )

  it.effect('a completed empty response becomes NoAnswer', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        messages: [assistant([])],
        settlements: [{ submissionId: runId, outcome: 'completed' }],
      })
      const result = yield* Fiber.join(run)
      expect(result).toEqual(Settlement.cases.Failed.make({ reason: 'NoAnswer' }))
    }),
  )

  it.effect('quotes the reconciled canonical text block in a finished notice', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      // Flue reconciles completion before it publishes the settlement.
      evidence.publish({
        conversationId: 'conversation',
        messages: [
          assistant([
            { type: 'text', text: 'Rivers bend for reasons that begin simply.', state: 'done' },
            { type: 'reasoning', text: 'hm', state: 'done' },
          ]),
        ],
        settlements: [{ submissionId: runId, outcome: 'completed' }],
      })
      const result = yield* Fiber.join(run)
      expect(result).toEqual(
        Settlement.cases.Completed.make({
          reply: 'Rivers bend for reasons that begin simply.',
          responseId: runId,
        }),
      )
    }),
  )

  it.effect('quotes distinct canonical text blocks as separate paragraphs', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        messages: [
          assistant([
            { type: 'text', text: 'First is done.', state: 'done' },
            { type: 'reasoning', text: '.', state: 'done' },
            { type: 'text', text: 'Next topic begins.', state: 'done' },
          ]),
        ],
        settlements: [{ submissionId: runId, outcome: 'completed' }],
      })
      expect(yield* Fiber.join(run)).toEqual(
        Settlement.cases.Completed.make({
          reply: 'First is done.\n\nNext topic begins.',
          responseId: runId,
        }),
      )
    }),
  )

  it.effect('a producing Run with no answer times out without aborting conversation work', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        messages: [assistant([])],
        settlements: [],
      })
      yield* TestClock.adjust('89999 millis')
      expect(evidence.closed()).toBe(false)
      yield* TestClock.adjust(1)
      const result = yield* Fiber.join(run)
      expect(result).toEqual(Settlement.cases.Failed.make({ reason: 'TimedOut' }))
      expect(evidence.aborted()).toBe(false)
      expect(evidence.closed()).toBe(true)
    }),
  )

  it.effect(
    'real first content allows a long answer to complete beyond the first-token deadline',
    () =>
      Effect.gen(function* () {
        const evidence = yield* fixture()
        const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.ready)
        evidence.publish({
          conversationId: 'conversation',
          messages: [assistant([{ type: 'text', text: 'Hello', state: 'streaming' }])],
          settlements: [],
        })
        yield* TestClock.adjust('120 seconds')
        evidence.publish({
          conversationId: 'conversation',
          messages: [assistant([{ type: 'text', text: 'Hello there', state: 'done' }])],
          settlements: [{ submissionId: runId, outcome: 'completed' }],
        })
        const result = yield* Fiber.join(run)
        expect(result).toEqual(
          Settlement.cases.Completed.make({ reply: 'Hello there', responseId: runId }),
        )
        expect(evidence.aborted()).toBe(false)
      }),
  )
  it.effect(
    'a joined Run still reads its host reply after 91 seconds without aborting other work',
    () =>
      Effect.gen(function* () {
        const evidence = yield* fixture()
        const host = 'host-run'
        const hostMessage = {
          ...assistant([{ type: 'text', text: 'Host answer', state: 'streaming' }]),
          submissionId: host,
        }
        const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.ready)
        evidence.publish({
          conversationId: 'conversation',
          messages: [hostMessage],
          settlements: [],
        })
        yield* TestClock.adjust('91 seconds')
        expect(evidence.closed()).toBe(false)
        expect(evidence.aborted()).toBe(false)
        evidence.publish({
          conversationId: 'conversation',
          messages: [hostMessage],
          settlements: [
            { submissionId: runId, outcome: 'completed', answeredBySubmissionId: host },
          ],
        })
        expect(yield* Fiber.join(run)).toEqual(
          Settlement.cases.Completed.make({ reply: 'Host answer', responseId: RunId.make(host) }),
        )
      }),
  )

  it.effect('an old unrelated answer cannot extend a joined Run first-content deadline', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      evidence.publish({
        conversationId: 'conversation',
        messages: [
          {
            ...assistant([{ type: 'text', text: 'Old answer', state: 'done' }]),
            submissionId: 'old-run',
          },
        ],
        settlements: [{ submissionId: 'old-run', outcome: 'completed' }],
      })
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      yield* TestClock.adjust('89999 millis')
      expect(evidence.closed()).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Failed.make({ reason: 'TimedOut' }))
    }),
  )

  for (const phase of ['absent', 'closed', 'error'] as const) {
    for (const spoke of [false, true]) {
      it.effect(`settles ${phase} as Unknown with prior content ${spoke}`, () =>
        Effect.gen(function* () {
          const evidence = yield* fixture()
          const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
          yield* Queue.take(evidence.ready)
          if (spoke)
            evidence.publish({
              conversationId: 'conversation',
              settlements: [],
              messages: [assistant([{ type: 'text', text: 'Hello', state: 'streaming' }])],
            })
          evidence.phase(phase)
          expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Unknown.make({}))
          expect(evidence.aborted()).toBe(false)
          expect(evidence.closed()).toBe(true)
        }),
      )
    }
  }

  for (const spoke of [false, true]) {
    it.effect(`bounds unreachable runtime after restart with prior content ${spoke}`, () =>
      Effect.gen(function* () {
        const evidence = yield* fixture()
        if (spoke)
          evidence.publish({
            conversationId: 'conversation',
            settlements: [],
            messages: [assistant([{ type: 'text', text: 'Before restart', state: 'streaming' }])],
          })
        evidence.disconnect(new Error('ECONNREFUSED'))
        const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.ready)
        yield* TestClock.adjust('89 seconds')
        evidence.phase('loading')
        evidence.phase('connecting')
        yield* TestClock.adjust('1 second')
        expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Unknown.make({}))
        expect(evidence.aborted()).toBe(false)
        expect(evidence.closed()).toBe(true)
      }),
    )
  }

  it.effect('starts the content deadline before the first assistant message', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({ conversationId: 'conversation', messages: [], settlements: [] })
      yield* TestClock.adjust('80 seconds')
      evidence.publish({
        conversationId: 'conversation',
        messages: [assistant([])],
        settlements: [],
      })
      yield* TestClock.adjust('9999 millis')
      expect(evidence.closed()).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Failed.make({ reason: 'TimedOut' }))
      expect(evidence.aborted()).toBe(false)
    }),
  )

  it.effect('bounds reconnect loss after live content independently of durability', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        settlements: [],
        messages: [assistant([{ type: 'text', text: 'Hello', state: 'streaming' }])],
      })
      yield* TestClock.adjust('120 seconds')
      evidence.disconnect(new Error('Agent conversation stream stalled'))
      yield* TestClock.adjust('89999 millis')
      expect(evidence.closed()).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Unknown.make({}))
    }),
  )

  it.effect(
    'only live recovery resets the unavailable window and preserves a saved settlement',
    () =>
      Effect.gen(function* () {
        const evidence = yield* fixture()
        const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.ready)
        evidence.disconnect(new Error('HTTP 503'))
        yield* TestClock.adjust('80 seconds')
        evidence.publish({
          conversationId: 'conversation',
          settlements: [],
          messages: [assistant([{ type: 'text', text: 'Hello', state: 'streaming' }])],
        })
        yield* TestClock.adjust('20 seconds')
        evidence.disconnect(new Error('ECONNREFUSED'))
        yield* TestClock.adjust('89 seconds')
        evidence.publish({
          conversationId: 'conversation',
          settlements: [{ submissionId: runId, outcome: 'completed' }],
          messages: [assistant([{ type: 'text', text: 'Hello', state: 'done' }])],
        })
        evidence.disconnect(new Error('HTTP 503'))
        expect(yield* Fiber.join(run)).toEqual(
          Settlement.cases.Completed.make({ reply: 'Hello', responseId: runId }),
        )
      }),
  )

  it.effect('a live partial answer still has the one-hour durability bound', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({
        conversationId: 'conversation',
        settlements: [],
        messages: [assistant([{ type: 'text', text: 'Hello', state: 'streaming' }])],
      })
      // The product promises one hour. An imported deadline would let a wrongly shortened
      // production timeout redefine its own expected behavior.
      yield* TestClock.adjust('3599999 millis')
      expect(evidence.closed()).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Unknown.make({}))
    }),
  )
})
