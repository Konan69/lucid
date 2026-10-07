import { Effect } from 'effect'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import * as Option from 'effect/Option'
import { describe, expect, it } from '@effect/vitest'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { decide, history, streamRun, toolsExtension, waiting } from '../main.ts'
import { consume, texts } from '../conformance/fixtures/host.ts'
import { postgresFixture } from './testing.ts'
const context = BACKGROUND_CONTEXT
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
/** Adapt conformance/fixtures/host.ts:host to our PostgreSQL opener. Real Pi owns
 * all persisted state; each reopen creates fresh models, registry and harness.
 * Cleanup is registered before any storage or Harness initialization writes. */
function host() {
  const fixture = postgresFixture(Option.getOrThrow(testUrl))
  const harnesses = new Set<Harness>()
  const payments: number[] = []
  onTestFinished(() =>
    Array.from(harnesses).reduce(
      (closed, harness) => closed.then(() => harness.close(context)),
      Promise.resolve(),
    ),
  )
  /** Models are faux only; no provider credentials or network calls are used. */
  function open() {
    return Effect.gen(function* () {
      const faux = fauxProvider()
      const models = createModels()
      models.setProvider(faux.provider)
      const registry = createRegistry()
      registry.install(
        yield* Effect.promise(() =>
          toolsExtension(
            'postgres',
            {
              pay: tool({
                description: 'Record a payment',
                inputSchema: z.object({ amount: z.number() }),
                execute: ({ amount }) => {
                  payments.push(amount)
                  return Promise.resolve({ receipt: amount })
                },
              }),
            },
            { approval: { pay: true } },
          ),
        ),
      )
      const harness = yield* Effect.flatMap(
        Effect.promise(() => fixture.open()),
        (_await2) =>
          Effect.promise(() =>
            Harness.open(
              _await2,
              { models, registry, settings: { retry: { baseDelayMs: 0 } } },
              context,
            ),
          ),
      )
      harnesses.add(harness)
      const root = yield* Effect.promise(() =>
        harness.root(context, {
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        }),
      )
      return { harness, root, faux }
    })
  }
  /** Remove settled volatile ownership before reopening the same schema. */
  function close(harness: Harness) {
    return Effect.gen(function* () {
      yield* Effect.promise(() => harness.close(context))
      harnesses.delete(harness)
    })
  }
  return { open, close, payments }
}
describe.skipIf(Option.isNone(testUrl))('PostgreSQL run persistence', () => {
  /** conformance/history.test.ts:history matches streamed text parts and
   * conformance/pi.test.ts restart cases, using streamRun from the Promise entry. */
  it.live('streams a turn, settles, and returns identical history after reopening', () =>
    Effect.gen(function* () {
      const fixture = host()
      const before = yield* fixture.open()
      before.faux.setResponses([fauxAssistantMessage('The turn completed.')])
      const streamed = yield* Effect.flatMap(
        Effect.promise(() =>
          streamRun(
            before.harness,
            {
              conversationId: before.root.id,
              content: 'Complete the turn',
              requestId: 'turn',
            },
            context,
          ),
        ),
        (_await3) => Effect.promise(() => consume(_await3)),
      )
      yield* Effect.promise(() => before.root.waitForIdle(context))
      expect(texts(streamed.message)).toEqual(['The turn completed.'])
      const prior = yield* Effect.promise(() =>
        history(before.harness, before.root.id, { limit: 10 }, context),
      )
      expect(prior.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
      expect(Option.getOrThrow(Option.fromNullishOr(prior.messages[1])).parts).toEqual(
        streamed.message.parts,
      )
      expect(streamed.chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
      expect(Option.getOrThrow(Option.fromNullishOr(streamed.chunks.at(-1))).type).toBe('finish')
      yield* fixture.close(before.harness)
      const after = yield* fixture.open()
      expect(after.root.id).toBe(before.root.id)
      expect(
        yield* Effect.promise(() => history(after.harness, after.root.id, { limit: 10 }, context)),
      ).toEqual(prior)
    }),
  )
  /** conformance/cloudflare.test.ts:a decision after restart settles the original
   * hold. Approval survives loss of the first Harness; a repeated decision cannot
   * execute the tool again. No mocked storage or bridge internals are used. */
  it.live('parks approval, reopens, decides the original hold, and executes once', () =>
    Effect.gen(function* () {
      const fixture = host()
      const before = yield* fixture.open()
      before.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', { amount: 500 }, { id: 'payment' })], {
          stopReason: 'toolUse',
        }),
      ])
      const parked = yield* Effect.flatMap(
        Effect.promise(() =>
          streamRun(
            before.harness,
            {
              conversationId: before.root.id,
              content: 'Record the payment',
              requestId: 'payment',
            },
            context,
          ),
        ),
        (_await4) => Effect.promise(() => consume(_await4)),
      )
      expect(parked.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true)
      const holds = yield* Effect.promise(() => waiting(before.harness, before.root.id, context))
      expect(holds).toHaveLength(1)
      const hold = Option.getOrThrow(Option.fromNullishOr(holds[0]))
      expect(hold.kind).toBe('approval')
      expect(fixture.payments).toEqual([])
      yield* fixture.close(before.harness)
      const after = yield* fixture.open()
      after.faux.setResponses([fauxAssistantMessage('Payment recorded.')])
      expect(
        yield* Effect.promise(() => waiting(after.harness, after.root.id, context)),
      ).toMatchObject([{ holdId: hold.holdId, callId: 'payment', kind: 'approval' }])
      const decision = { holdId: hold.holdId, approved: true }
      expect(
        yield* Effect.promise(() => decide(after.harness, after.root.id, decision, context)),
      ).toEqual({
        kind: 'approved',
      })
      yield* Effect.promise(() => after.root.waitForIdle(context))
      expect(
        yield* Effect.promise(() => decide(after.harness, after.root.id, decision, context)),
      ).toEqual({
        kind: 'approved',
      })
      expect(fixture.payments).toEqual([500])
      expect(yield* Effect.promise(() => waiting(after.harness, after.root.id, context))).toEqual(
        [],
      )
      const settled = yield* Effect.promise(() =>
        history(after.harness, after.root.id, { limit: 10 }, context),
      )
      expect(settled.messages.flatMap((message) => texts(message))).toContain('Payment recorded.')
    }),
  )
})
