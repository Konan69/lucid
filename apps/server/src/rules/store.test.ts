import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { AuditEvent, Forbidden, NotFound, RuleScope, SessionId } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { fixture, trustTestLayer } from '../approvals/testing.ts'
import { loadAudit } from '../audit/store.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ruleHandlers } from './handlers.ts'
import { RuleStore } from './store.ts'

/** Production access predicates enforce Company policy without granting access to private records. */
describe.skipIf(!testDatabaseConfigured)('Rules and audit reach', () => {
  it.effect(
    'a non-admin Member cannot add Company policy or see another Person in Company audit',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const rules = yield* RuleStore
        const rejected = yield* Effect.result(
          rules.create(test.member, {
            action: 'Send messages',
            decision: 'Allow',
            scope: RuleScope.cases.Company.make({}),
          }),
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected)) expect(rejected.failure).toBeInstanceOf(Forbidden)
        yield* rules.create(test.owner, {
          action: 'Ask before sending',
          decision: 'Ask',
          scope: RuleScope.cases.Company.make({}),
        })
        expect((yield* loadAudit(test.member)).entries).toEqual([])
        const visible = (yield* loadAudit(test.owner)).entries
        expect(visible.map((entry) => entry.event)).toEqual([
          AuditEvent.cases.RuleAdded.make({ action: 'Ask before sending', decision: 'Ask' }),
        ])
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('personal policy follows its owner and cannot be deleted by a Company owner', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const rules = yield* RuleStore
      const mine = yield* rules.create(test.personal, {
        action: 'Ask before sending',
        decision: 'Ask',
        scope: RuleScope.cases.Personal.make({}),
      })
      expect((yield* rules.list(test.member)).map((rule) => rule.id)).toContain(mine.id)
      expect(yield* rules.list(test.owner)).toEqual([])
      const denied = yield* Effect.result(rules.remove(test.owner, mine.id))
      expect(Result.isFailure(denied)).toBe(true)
      if (Result.isFailure(denied)) expect(denied.failure).toBeInstanceOf(NotFound)
      yield* rules.remove(test.personal, mine.id)
      expect(yield* rules.list(test.member)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('Vivid cannot create or delete policy through the RPC handlers', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const auth = AuthState.Vivid({
        person: test.personal.person,
        workspace: test.personal.workspace,
        threadId: test.personalId,
      })
      const created = yield* Effect.result(
        ruleHandlers
          .CreateRule({
            action: 'Allow work',
            decision: 'Allow',
            scope: RuleScope.cases.Personal.make({}),
          })
          .pipe(Effect.provideService(AuthContext, auth)),
      )
      expect(Result.isFailure(created)).toBe(true)
      if (Result.isFailure(created)) expect(created.failure).toBeInstanceOf(Forbidden)
      const listed = yield* ruleHandlers.ListRules().pipe(
        Effect.provideService(
          AuthContext,
          AuthState.Person({
            person: test.personal.person,
            workspace: test.personal.workspace,
            sessionId: SessionId.make('test-session'),
          }),
        ),
      )
      expect(listed.rules).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
