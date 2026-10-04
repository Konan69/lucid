import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect, Schema } from 'effect'
import { Decision } from 'effect/unstable/ai'
import { decide } from './model.ts'
import { liveDecisionEnabled, liveDecisionLayer } from './testing.ts'

const Ticket = Decision.make({
  input: Schema.Struct({ subject: Schema.String, body: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: 'Which team should handle this',
      criteria: { billing: 'Payments and invoices', technical: 'Bugs and outages' },
    }),
    frustration: Decision.rate({
      instructions: 'How frustrated the writer is',
      criteria: ['calm', 'frustrated', 'angry'],
    }),
    urgent: Decision.probability({
      instructions: 'The message needs action today',
      criteria: { false: 'No time pressure', true: 'Needs action today' },
    }),
  },
})

/** Claim: Vivid's own gateway answers every kind of decision through the Effect provider. */
describe.skipIf(!liveDecisionEnabled)('Jev through the gateway', () => {
  it.live('answers classify, rate and probability in one request', () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const { answers, usage } = yield* decide(Ticket, {
        subject: 'Charged twice, again',
        body: 'This is the third time you have double charged my card. Fix it today or I leave.',
      })
      const elapsed = (yield* Clock.currentTimeMillis) - start
      yield* Effect.logInfo(
        `Jev gateway: department=${answers.department.label} frustration=${answers.frustration.label} rating=${answers.frustration.rating.toFixed(2)} urgent=${answers.urgent.probability.toFixed(2)} tokens=${usage.inputTokens}/${usage.outputTokens} latency=${elapsed}ms`,
      )
      expect(answers.department.label).toBe('billing')
      expect(answers.frustration.label).not.toBe('calm')
      expect(answers.urgent.probability).toBeGreaterThan(0.5)
    }).pipe(Effect.provide(liveDecisionLayer)),
  )
})
