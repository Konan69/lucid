import { describe, expect, layer } from '@effect/vitest'
import { Clock, Effect, Layer } from 'effect'
import {
  ActionTarget,
  ConnectionId,
  PersonId,
  PersonSummary,
  ProposedAction,
  Rule,
  RuleId,
  RuleScope,
} from '@vivid/contracts'
import { liveDecisionEnabled, liveDecisionLayer } from '../decisions/testing.ts'
import { RuleJudge, ruleJudgeLayer } from './judge.ts'

const rule = Rule.make({
  id: RuleId.make('live-rule'),
  action: 'Never email people outside the company',
  decision: 'Never',
  scope: RuleScope.cases.Company.make({}),
  createdBy: PersonSummary.make({ id: PersonId.make('live-person'), name: 'Person', image: null }),
  createdAt: 1,
})

/** Public applicability must catch external NDA delivery without binding unrelated reads. */
layer(ruleJudgeLayer.pipe(Layer.provide(liveDecisionLayer)), { excludeTestServices: true })(
  (it) => {
    describe.skipIf(!liveDecisionEnabled)('Jev rule applicability', () => {
      it.effect('binds external NDA email and excludes reading a calendar', () =>
        Effect.gen(function* () {
          const judge = yield* RuleJudge
          for (const input of [
            {
              summary: 'Send the signed NDA to an external lawyer',
              effect: 'write',
              applies: true,
            },
            { summary: 'Read my calendar', effect: 'read', applies: false },
          ] as const) {
            const action = ProposedAction.make({
              summary: input.summary,
              effect: input.effect,
              rationale: 'Fulfill the request',
              target: ActionTarget.cases.Connection.make({
                connectionId: ConnectionId.make('private-live-connection'),
                account: 'Private account',
                tool: 'Private tool',
                input: {},
              }),
            })
            const start = yield* Clock.currentTimeMillis
            const result = yield* judge.judge(action, [rule])
            const elapsed = (yield* Clock.currentTimeMillis) - start
            yield* Effect.logInfo(
              `Jev rule: applies=${result.length === 1} expected=${input.applies} latency=${elapsed}ms`,
            )
            expect(result).toEqual(input.applies ? [rule] : [])
          }
        }),
      )
    })
  },
)
