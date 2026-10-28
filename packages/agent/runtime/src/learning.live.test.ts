import * as NodeProcess from 'node:process'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { DecisionModel } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Exchange, worthwhile } from './learning.ts'
import { decisionLayer } from './settings.ts'

/** Provider failures must not print request headers, credentials or response payloads. */
class JevUnavailable extends Schema.TaggedError<JevUnavailable>()(
  'JevUnavailable',
  {},
  { title: 'Jev did not answer' },
) {}

/** The opt-in flag and OpenRouter key belong to the caller. Normal gates make no provider call. */
describe.skipIf(NodeProcess.env['VIVID_LIVE_LEARNING'] !== '1')('Learning gate on real Jev', () => {
  layer(decisionLayer.pipe(Layer.provide(FetchHttpClient.layer)), { excludeTestServices: true })(
    (it) => {
      it.effect(
        'keeps a durable short answer and rejects a forget request',
        () =>
          Effect.gen(function* () {
            const exchange = Exchange.make({
              person: 'Ada',
              messages: ['Green tea, always.'],
              previousReply: 'What tea do you prefer?',
              reply: 'Okay.',
              replyWroteMemory: false,
              at: Date.UTC(2026, 9, 28, 12),
              timezone: 'UTC',
              remembered: [],
            })
            const keep = yield* DecisionModel.decide(worthwhile, { input: exchange }).pipe(
              Effect.timeout('10 seconds'),
              Effect.mapError(() => new JevUnavailable()),
            )
            const forget = yield* DecisionModel.decide(worthwhile, {
              input: {
                ...exchange,
                messages: ['Forget that I prefer green tea. Do not keep that preference.'],
                previousReply: null,
                reply: 'Removed.',
              },
            }).pipe(
              Effect.timeout('10 seconds'),
              Effect.mapError(() => new JevUnavailable()),
            )
            yield* Effect.logInfo('Learning gate probabilities', {
              keep: keep.answers.keep.probability,
              forget: forget.answers.keep.probability,
            })
            expect(keep.answers.keep.probability).toBeGreaterThanOrEqual(0.5)
            expect(forget.answers.keep.probability).toBeLessThan(0.5)
          }),
        // Two bounded ten-second requests plus Layer acquisition fit inside this runner budget.
        { timeout: 30_000 },
      )
    },
  )
})
