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
import { observeRun, responseTimeoutMillis, Settlement } from './settlement.ts'

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
  return { client, ready, publish, phase, closed: () => closed, aborted: () => aborted }
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
      yield* TestClock.adjust('90 seconds')
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
        expect(result).toEqual(Settlement.cases.Completed.make({ reply: 'Hello there' }))
        expect(evidence.aborted()).toBe(false)
      }),
  )
  it.effect('a queued Run outlives its first-token budget and reads its host reply', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      const host = 'host-run'
      const hostMessage = {
        ...assistant([{ type: 'text', text: 'Host answer', state: 'streaming' }]),
        submissionId: host,
      }
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.publish({ conversationId: 'conversation', messages: [hostMessage], settlements: [] })
      yield* TestClock.adjust('120 seconds')
      expect(evidence.aborted()).toBe(false)
      evidence.publish({
        conversationId: 'conversation',
        messages: [hostMessage],
        settlements: [{ submissionId: runId, outcome: 'completed', answeredBySubmissionId: host }],
      })
      expect(yield* Fiber.join(run)).toEqual(
        Settlement.cases.Completed.make({ reply: 'Host answer' }),
      )
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

  it.effect('resumed partial output cannot pin a Run beyond the Flue durability bound', () =>
    Effect.gen(function* () {
      const evidence = yield* fixture()
      evidence.publish({
        conversationId: 'conversation',
        settlements: [],
        messages: [assistant([{ type: 'text', text: 'Before restart', state: 'streaming' }])],
      })
      const run = yield* observeRun(evidence.client, runId, 90_000).pipe(Effect.forkScoped)
      yield* Queue.take(evidence.ready)
      evidence.phase('connecting')
      yield* TestClock.adjust(responseTimeoutMillis)
      expect(yield* Fiber.join(run)).toEqual(Settlement.cases.Unknown.make({}))
      expect(evidence.aborted()).toBe(false)
    }),
  )
})
