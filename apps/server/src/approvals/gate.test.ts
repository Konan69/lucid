import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import {
  ActionTarget,
  AuditEvent,
  BrowserAction,
  ProposedAction,
  RuleScope,
} from '@vivid/contracts'
import { loadAudit } from '../audit/store.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { RuleStore } from '../rules/store.ts'
import { Gate, GateDecision } from './gate.ts'
import { ApprovalStore } from './store.ts'
import {
  commandAction,
  connectionAction,
  fixture,
  JudgmentMode,
  Observation,
  trustTestLayer,
} from './testing.ts'

/** Policy is tested with production stores, including the durable Approval raised by the real gate. */
describe.skipIf(!testDatabaseConfigured)('Trust gate precedence and defaults', () => {
  it.effect('a personal Allow never overrides a Company Ask', () =>
    Effect.gen(function* () {
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
      const decision = yield* (yield* Gate).check(test.companyVivid, connectionAction, 'Ordinary')
      expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
      expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('Never wins over Ask and Allow and records the blocking wording', () =>
    Effect.gen(function* () {
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
      const decision = yield* (yield* Gate).check(test.companyVivid, connectionAction, 'Ordinary')
      expect(decision).toEqual(GateDecision.cases.Blocked.make({ rule: 'Never update projects' }))
      expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toEqual([])
      const audit = yield* loadAudit(test.owner)
      expect(audit.entries.some((entry) => AuditEvent.guards.ActionBlocked(entry.event))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('judge failure asks even on the Computer', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* (yield* RuleStore).create(test.personal, {
        action: 'Inspect files',
        decision: 'Allow',
        scope: RuleScope.cases.Personal.make({}),
      })
      yield* Ref.set((yield* Observation).judgment, JudgmentMode.cases.Failed.make({}))
      const decision = yield* (yield* Gate).check(test.vivid, commandAction, 'Ordinary')
      expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('destructive actions ask even with applicable Allow policy', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* (yield* RuleStore).create(test.personal, {
        action: 'Update projects',
        decision: 'Allow',
        scope: RuleScope.cases.Personal.make({}),
      })
      const destructive = ProposedAction.make({ ...connectionAction, effect: 'destructive' })
      const decision = yield* (yield* Gate).check(test.vivid, destructive, 'Ordinary')
      expect(GateDecision.guards.ApprovalRequired(decision)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('unmatched Computer commands and browser steps are allowed without audit noise', () =>
    Effect.gen(function* () {
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
      expect(yield* gate.check(test.vivid, commandAction, 'Ordinary')).toEqual(
        GateDecision.cases.Allowed.make({}),
      )
      expect(yield* gate.check(test.vivid, browser, 'Ordinary')).toEqual(
        GateDecision.cases.Allowed.make({}),
      )
      expect((yield* loadAudit(test.personal)).entries).toEqual([])
      expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect(
    'unmatched Connection writes ask, while applicable Allow records the account label',
    () =>
      Effect.gen(function* () {
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
            summary: connectionAction.summary,
            service: 'Work account',
            effect: 'write',
          }),
        ])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('ordinary reads bypass rules, while personal data exposed in shared work asks', () =>
    Effect.gen(function* () {
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
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
