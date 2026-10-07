import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  ActionTarget,
  BrowserAction,
  BrowseTarget,
  ProposedAction,
  RuleScope,
} from '@vivid/contracts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { disabledDecisionLayer } from '../decisions/model.ts'
import { ruleJudgeLayer } from '../rules/judge.ts'
import { RuleStore } from '../rules/store.ts'
import { Runtime } from '../runtime/client.ts'
import { Gate, GateDecision, gateLayer } from './gate.ts'
import { reviewerLayer } from './review.ts'
import { desktopAction, connectionAction, fixture, storeServices } from './testing.ts'

/**
 * The gate over the production Reviewer and RuleJudge with decisions switched off, which is how
 * the server starts by default. The runtime dies if history is read: off must do no review work.
 */
const offLayer = gateLayer.pipe(
  Layer.provideMerge(reviewerLayer),
  Layer.provideMerge(ruleJudgeLayer),
  Layer.provideMerge(disabledDecisionLayer),
  Layer.provideMerge(
    Layer.mock(Runtime, { read: () => Effect.die('History is not read while decisions are off') }),
  ),
  Layer.provideMerge(storeServices),
)

/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('The gate with decisions switched off', () => {
    it.effect('a write on the Person’s own browser runs and a destructive one asks', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(offLayer)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          // Konan, 4 Oct 2026: "I don't need approval for writing my browser". The Person's own
          // signed-in browser follows the Integration table (`policy.ts#reviewOutcome`).
          const action = ProposedAction.make({
            summary: 'Click Send',
            rationale: '',
            effect: 'write',
            target: ActionTarget.cases.Browser.make({
              target: BrowseTarget.cases.Person.make({}),
              action: BrowserAction.cases.Click.make({ target: 'Send' }),
            }),
          })
          expect(yield* gate.check(test.vivid, action, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          const destructive = ProposedAction.make({ ...action, effect: 'destructive' })
          expect(
            GateDecision.guards.ApprovalRequired(
              yield* gate.check(test.vivid, destructive, 'Ordinary'),
            ),
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('a write on the Person’s own Integration runs and a destructive action asks', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(offLayer)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          expect(yield* gate.check(test.vivid, connectionAction, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          const destructive = ProposedAction.make({ ...connectionAction, effect: 'destructive' })
          expect(
            GateDecision.guards.ApprovalRequired(
              yield* gate.check(test.vivid, destructive, 'Ordinary'),
            ),
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('an Allow rule changes nothing, and a Never or Ask rule asks about everything', () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(offLayer)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          const rules = yield* RuleStore
          yield* rules.create(test.personal, {
            action: 'Update projects',
            decision: 'Allow',
            scope: RuleScope.cases.Personal.make({}),
          })
          expect(yield* gate.check(test.vivid, connectionAction, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          // No rule can be judged while off, so one that could forbid leaves every action open.
          yield* rules.create(test.personal, {
            action: 'Never email people outside the company',
            decision: 'Never',
            scope: RuleScope.cases.Personal.make({}),
          })
          for (const action of [connectionAction, desktopAction])
            expect(
              GateDecision.guards.ApprovalRequired(
                yield* gate.check(test.vivid, action, 'Ordinary'),
              ),
            ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
