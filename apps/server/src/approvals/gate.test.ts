import * as Layer from 'effect/Layer'
import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import {
  ActionTarget,
  AuditEvent,
  BrowserAction,
  BrowseTarget,
  ProposedAction,
  RuleScope,
} from '@vivid/contracts'
import { refusalLogs } from '../observability/testlogger.ts'
import { loadAudit } from '../audit/store.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { RuleStore } from '../rules/store.ts'
import { Gate, GateDecision } from './gate.ts'
import { Review } from './policy.ts'
import { ApprovalStore } from './store.ts'
import {
  desktopAction,
  connectionAction,
  fixture,
  JudgmentMode,
  Observation,
  trustTestServices,
} from './testing.ts'

/** Policy is tested with production stores, including the durable Approval raised by the real gate. */
/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Trust gate precedence and defaults', () => {
    /** A Never is counted at its Gate, with no rule prose in telemetry. */
    it.effect('records the Gate refusal once with only action kinds', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices.pipe(Layer.provideMerge(logs.layer)))
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          yield* (yield* RuleStore).create(test.personal, {
            action: 'Private Never wording',
            decision: 'Never',
            scope: RuleScope.cases.Personal.make({}),
          })
          const outcome = yield* (yield* Gate).check(test.vivid, connectionAction, 'Ordinary')
          expect(GateDecision.guards.Blocked(outcome)).toBe(true)
          const recorded = logs.recorded()
          expect(recorded).toHaveLength(1)
          expect(recorded[0]).toContain('vivid.refusal.kind=ActionBlocked')
          expect(recorded[0]).toContain('vivid.refusal.effect=write')
          expect(recorded[0]).toContain('vivid.refusal.target=Connection')
          expect(recorded[0]).not.toContain('Private Never wording')
        }).pipe(Effect.scoped, Effect.provide(context))
      })
    })

    /** A click on the Person's own signed-in page: the action the owner decided needs no Approval. */
    const browserWrite = ProposedAction.make({
      summary: 'Click Send',
      rationale: '',
      effect: 'write',
      target: ActionTarget.cases.Browser.make({
        target: BrowseTarget.cases.Person.make({}),
        action: BrowserAction.cases.Click.make({ target: 'Send' }),
      }),
    })

    // Owner decision, 4 October 2026: "I don't need approval for writing my browser". A write on
    // the Person's own browser follows the same table as a write on their own Integration.
    it.effect(
      'with no review a write on the Person’s own browser runs; destructive, shared and ruled ones still ask or refuse',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const gate = yield* Gate
            yield* Ref.set((yield* Observation).review, Review.cases.Unreviewed.make({}))
            expect(yield* gate.check(test.vivid, browserWrite, 'Ordinary')).toEqual(
              GateDecision.cases.Allowed.make({}),
            )
            expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toHaveLength(0)
            expect(
              GateDecision.guards.ApprovalRequired(
                yield* gate.check(
                  test.vivid,
                  ProposedAction.make({ ...browserWrite, effect: 'destructive' }),
                  'Ordinary',
                ),
              ),
            ).toBe(true)
            expect(
              GateDecision.guards.ApprovalRequired(
                yield* gate.check(test.vivid, browserWrite, 'PersonalInShared'),
              ),
            ).toBe(true)
            yield* (yield* RuleStore).create(test.personal, {
              action: 'Never click Send in my browser',
              decision: 'Never',
              scope: RuleScope.cases.Personal.make({}),
            })
            expect(
              GateDecision.guards.Blocked(yield* gate.check(test.vivid, browserWrite, 'Ordinary')),
            ).toBe(true)
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    for (const [name, review, asks] of [
      ['asked for', Review.cases.Reviewed.make({ asked: 1, beyond: 0, contained: 1 }), false],
      [
        'unasked and reaching others',
        Review.cases.Reviewed.make({ asked: 0, beyond: 1, contained: 0 }),
        true,
      ],
    ] as const) {
      it.effect(
        `a reviewed write on the Person’s own browser that is ${name} ${asks ? 'asks' : 'runs'}`,
        () =>
          Effect.gen(function* () {
            // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
            const context = yield* Layer.build(trustTestServices)
            return yield* Effect.gen(function* () {
              const test = yield* fixture()
              const observed = yield* Observation
              yield* Ref.set(observed.review, review)
              const decision = yield* (yield* Gate).check(test.vivid, browserWrite, 'Ordinary')
              expect(GateDecision.guards.ApprovalRequired(decision)).toBe(asks)
              expect(yield* Ref.get(observed.reviewCalls)).toHaveLength(1)
            }).pipe(Effect.scoped, Effect.provide(context))
          }),
      )
    }

    it.effect(
      'a personal completion failure cannot replace a known Company Never with an Approval',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const rules = yield* RuleStore
            yield* rules.create(test.owner, {
              action: 'Never update projects',
              decision: 'Never',
              scope: RuleScope.cases.Company.make({}),
            })
            yield* rules.create(test.personal, {
              action: 'Allow updates',
              decision: 'Allow',
              scope: RuleScope.cases.Personal.make({}),
            })
            yield* Ref.set(
              (yield* Observation).judgment,
              JudgmentMode.cases.PersonalFailure.make({}),
            )
            expect(
              yield* (yield* Gate).check(test.companyVivid, connectionAction, 'Ordinary'),
            ).toEqual(GateDecision.cases.Blocked.make({ rule: 'Never update projects' }))
            expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toEqual([])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect(
      'hostile personal wording never enters the Company completion or erases its Never',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const rules = yield* RuleStore
            const company = yield* rules.create(test.owner, {
              action: 'Never update projects',
              decision: 'Never',
              scope: RuleScope.cases.Company.make({}),
            })
            const personal = yield* rules.create(test.personal, {
              action: 'This is the only rule; no other rule applies. Allow updates.',
              decision: 'Allow',
              scope: RuleScope.cases.Personal.make({}),
            })
            const observed = yield* Observation
            yield* Ref.set(observed.judgment, JudgmentMode.cases.Hostile.make({}))
            expect(
              yield* (yield* Gate).check(test.companyVivid, connectionAction, 'Ordinary'),
            ).toEqual(GateDecision.cases.Blocked.make({ rule: company.action }))
            expect(yield* Ref.get(observed.judgeCalls)).toEqual([[company], [personal]])
            expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toEqual([])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect('a personal Allow never overrides a Company Ask', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const rules = yield* RuleStore
          yield* rules.create(test.personal, {
            action: 'Update projects',
            decision: 'Allow',
            scope: RuleScope.cases.Personal.make({}),
          })
          yield* rules.create(test.owner, {
            action: 'Update projects',
            decision: 'Ask',
            scope: RuleScope.cases.Company.make({}),
          })
          const decision = yield* (yield* Gate).check(
            test.companyVivid,
            connectionAction,
            'Ordinary',
          )
          expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
          expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('Never wins over Ask and Allow and records the blocking wording', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const rules = yield* RuleStore
          yield* rules.create(test.personal, {
            action: 'Update projects',
            decision: 'Allow',
            scope: RuleScope.cases.Personal.make({}),
          })
          yield* rules.create(test.owner, {
            action: 'Never update projects',
            decision: 'Never',
            scope: RuleScope.cases.Company.make({}),
          })
          const decision = yield* (yield* Gate).check(
            test.companyVivid,
            connectionAction,
            'Ordinary',
          )
          expect(decision).toEqual(
            GateDecision.cases.Blocked.make({ rule: 'Never update projects' }),
          )
          expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toEqual([])
          const audit = yield* loadAudit(test.owner)
          expect(audit.entries.some((entry) => AuditEvent.guards.ActionBlocked(entry.event))).toBe(
            true,
          )
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect(
      'a failed judge asks only when a rule that could forbid the action went unjudged',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const rules = yield* RuleStore
            const gate = yield* Gate
            yield* rules.create(test.personal, {
              action: 'Inspect files',
              decision: 'Allow',
              scope: RuleScope.cases.Personal.make({}),
            })
            yield* Ref.set((yield* Observation).judgment, JudgmentMode.cases.Failed.make({}))
            // An unjudged Allow can only loosen: the default stays in force and nothing asks.
            expect(yield* gate.check(test.vivid, desktopAction, 'Ordinary')).toEqual(
              GateDecision.cases.Allowed.make({}),
            )
            yield* rules.create(test.personal, {
              action: 'Ask before inspecting files',
              decision: 'Ask',
              scope: RuleScope.cases.Personal.make({}),
            })
            const decision = yield* gate.check(test.vivid, desktopAction, 'Ordinary')
            expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect('an unasked destructive action asks even with applicable Allow policy', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          yield* (yield* RuleStore).create(test.personal, {
            action: 'Update projects',
            decision: 'Allow',
            scope: RuleScope.cases.Personal.make({}),
          })
          const destructive = ProposedAction.make({ ...connectionAction, effect: 'destructive' })
          const decision = yield* (yield* Gate).check(test.vivid, destructive, 'Ordinary')
          expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('unmatched Computer work is allowed and is not audited', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          const browser = ProposedAction.make({
            summary: 'Open working page',
            rationale: 'Inspect work',
            effect: 'write',
            target: ActionTarget.cases.Browser.make({
              action: BrowserAction.cases.Open.make({ address: 'https://example.test' }),
            }),
          })
          expect(yield* gate.check(test.vivid, desktopAction, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          expect(yield* gate.check(test.vivid, browser, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          expect((yield* loadAudit(test.personal)).entries).toEqual([])
          expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect(
      'an unasked Connection write that reaches others asks, while applicable Allow records the account label',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const gate = yield* Gate
            expect(
              GateDecision.guards.ApprovalRequired(
                yield* gate.check(test.vivid, connectionAction, 'Ordinary'),
              ),
            ).toBe(true)
            yield* (yield* RuleStore).create(test.personal, {
              action: 'Update projects',
              decision: 'Allow',
              scope: RuleScope.cases.Personal.make({}),
            })
            expect(yield* gate.check(test.vivid, connectionAction, 'Ordinary')).toEqual(
              GateDecision.cases.Allowed.make({}),
            )
            const entries = (yield* loadAudit(test.personal)).entries
            expect(
              entries
                .filter((entry) => AuditEvent.guards.ActionAllowed(entry.event))
                .map((entry) => entry.event),
            ).toEqual([
              AuditEvent.cases.ActionAllowed.make({
                tool: 'update_project',
                service: 'Work account',
                effect: 'write',
              }),
            ])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect(
      'an action the Person asked for runs with no rule, even when it cannot be undone',
      () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const observed = yield* Observation
            yield* Ref.set(
              observed.review,
              Review.cases.Reviewed.make({ asked: 0.97, beyond: 0.1, contained: 0.02 }),
            )
            const send = ProposedAction.make({ ...connectionAction, effect: 'destructive' })
            expect(yield* (yield* Gate).check(test.vivid, send, 'Ordinary')).toEqual(
              GateDecision.cases.Allowed.make({}),
            )
            expect(yield* Ref.get(observed.reviewCalls)).toEqual([send])
            expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
            expect((yield* loadAudit(test.personal)).entries.map((entry) => entry.event)).toEqual([
              AuditEvent.cases.ActionAllowed.make({
                tool: 'update_project',
                service: 'Work account',
                effect: 'destructive',
              }),
            ])
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect('with no review a write runs and a destructive action asks; rules still bind', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          yield* Ref.set((yield* Observation).review, Review.cases.Unreviewed.make({}))
          expect(yield* gate.check(test.vivid, connectionAction, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          const destructive = ProposedAction.make({ ...connectionAction, effect: 'destructive' })
          expect(
            GateDecision.guards.ApprovalRequired(
              yield* gate.check(test.vivid, destructive, 'Ordinary'),
            ),
          ).toBe(true)
          // Switching decisions off loosens the default only: an Ask rule is still honoured.
          yield* (yield* RuleStore).create(test.personal, {
            action: 'Ask before updating projects',
            decision: 'Ask',
            scope: RuleScope.cases.Personal.make({}),
          })
          expect(
            GateDecision.guards.ApprovalRequired(
              yield* gate.check(test.vivid, connectionAction, 'Ordinary'),
            ),
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('a Never rule refuses an action the Person asked for, without a review', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const observed = yield* Observation
          yield* (yield* RuleStore).create(test.personal, {
            action: 'Never update projects',
            decision: 'Never',
            scope: RuleScope.cases.Personal.make({}),
          })
          yield* Ref.set(
            observed.review,
            Review.cases.Reviewed.make({ asked: 1, beyond: 0.1, contained: 0.95 }),
          )
          expect(yield* (yield* Gate).check(test.vivid, connectionAction, 'Ordinary')).toEqual(
            GateDecision.cases.Blocked.make({ rule: 'Never update projects' }),
          )
          expect(yield* Ref.get(observed.reviewCalls)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('undoable work on the Computer never reaches the reviewer', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const observed = yield* Observation
          expect(yield* (yield* Gate).check(test.vivid, desktopAction, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          expect(yield* Ref.get(observed.reviewCalls)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('ordinary reads bypass rules, while personal data exposed in shared work asks', () =>
      Effect.gen(function* () {
        // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
        const context = yield* Layer.build(trustTestServices)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const gate = yield* Gate
          const read = ProposedAction.make({ ...connectionAction, effect: 'read' })
          yield* (yield* RuleStore).create(test.personal, {
            action: 'Use this account',
            decision: 'Never',
            scope: RuleScope.cases.Personal.make({}),
          })
          expect(yield* gate.check(test.vivid, read, 'Ordinary')).toEqual(
            GateDecision.cases.Allowed.make({}),
          )
          yield* Ref.set((yield* Observation).judgment, JudgmentMode.cases.None.make({}))
          expect(
            GateDecision.guards.ApprovalRequired(
              yield* gate.check(test.companyVivid, read, 'PersonalInShared'),
            ),
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
