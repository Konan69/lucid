import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import {
  ApprovalDecision,
  ApprovalState,
  Conflict,
  DatabaseFailure,
  NotFound,
  RuleScope,
  RuntimeUnavailable,
} from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { loadAudit } from '../audit/store.ts'
import { RuleStore } from '../rules/store.ts'
import { ActionOutcome } from './gate.ts'
import { ApprovalStore } from './store.ts'
import { approvals } from './tables.ts'
import { connectionAction, fixture, Observation, trustTestLayer } from './testing.ts'

const once = ApprovalDecision.cases.AllowOnce.make({})

/** All writes use production stores against the isolated database; disabled without its explicit URL. */
describe.skipIf(!testDatabaseConfigured)('Approval claims and outcomes', () => {
  it.effect('two concurrent decisions execute once and the loser gets Conflict', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const approval = yield* store.raise(test.vivid, connectionAction)
      const request = { id: approval.id, digest: approval.digest, decision: once }
      const results = yield* Effect.all(
        [
          Effect.result(store.decide(test.personal, request)),
          Effect.result(store.decide(test.personal, request)),
        ],
        { concurrency: 2 },
      )
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      const failures = results.filter(Result.isFailure)
      expect(failures.map((result) => result.failure)).toEqual([expect.any(Conflict)])
      const observed = yield* Observation
      expect(yield* Ref.get(observed.actions)).toEqual([connectionAction])
      const deliveries = yield* Ref.get(observed.deliveries)
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({
        idempotencyKey: `approval-${approval.id}`,
        personId: test.personal.person.id,
        message: { type: 'approval', attributes: { outcome: 'Succeeded' } },
      })
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('a changed digest fails without executing', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const approval = yield* store.raise(test.vivid, connectionAction)
      const result = yield* Effect.result(
        store.decide(test.personal, { id: approval.id, digest: 'wrong', decision: once }),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(Conflict)
      expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect(
    'an expired Approval cannot be decided and the sweeper publishes its settled state',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ApprovalStore
        const approval = yield* store.raise(test.vivid, connectionAction)
        const database = yield* Database
        yield* database.run(
          database
            .update(approvals)
            .set({ expiresAt: yield* Clock.currentTimeMillis })
            .where(eq(approvals.id, approval.id)),
        )
        const result = yield* Effect.result(
          store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: once }),
        )
        if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(Conflict)
        expect(Result.isFailure(result)).toBe(true)
        yield* store.expire()
        const records = yield* store.inThread(test.personalId)
        const expired = records[0]
        expect(expired).toBeDefined()
        if (expired !== undefined) expect(ApprovalState.guards.Expired(expired.state)).toBe(true)
        expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
        expect(yield* Ref.get((yield* Observation).topics)).toContain(`t:${test.personalId}`)
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('another Person including the Company owner gets NotFound', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const approval = yield* store.raise(test.companyVivid, connectionAction)
      const result = yield* Effect.result(
        store.decide(test.owner, { id: approval.id, digest: approval.digest, decision: once }),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(NotFound)
      expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
      expect(yield* store.inbox(test.owner)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('Unknown is stored and a later decision never runs the action again', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const observed = yield* Observation
      yield* Ref.set(observed.outcome, ActionOutcome.cases.Unknown.make({}))
      const approval = yield* store.raise(test.vivid, connectionAction)
      const request = { id: approval.id, digest: approval.digest, decision: once }
      const settled = yield* store.decide(test.personal, request)
      expect(ApprovalState.guards.OutcomeUnknown(settled.state)).toBe(true)
      const again = yield* Effect.result(store.decide(test.personal, request))
      expect(Result.isFailure(again)).toBe(true)
      expect(yield* Ref.get(observed.actions)).toEqual([connectionAction])
      const audit = yield* loadAudit(test.personal)
      expect(audit.entries.map((entry) => entry.event._tag)).toContain('ActionOutcomeUnknown')
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect(
    'AlwaysAllow writes personal policy, executes stored input, and settles despite delivery failure',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ApprovalStore
        const observed = yield* Observation
        yield* Ref.set(
          observed.deliveryFailure,
          Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
        )
        const approval = yield* store.raise(test.companyVivid, connectionAction)
        const settled = yield* store.decide(test.member, {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.AlwaysAllow.make({}),
        })
        expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
        expect(yield* Ref.get(observed.actions)).toEqual([connectionAction])
        const rules = yield* (yield* RuleStore).list(test.personal)
        expect(rules).toHaveLength(1)
        expect(rules[0]).toMatchObject({
          action: connectionAction.summary,
          decision: 'Allow',
          scope: RuleScope.cases.Personal.make({}),
        })
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('simultaneous identical proposals share one pending Approval and notification', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const results = yield* Effect.all(
        [store.raise(test.vivid, connectionAction), store.raise(test.vivid, connectionAction)],
        { concurrency: 2 },
      )
      expect(results[0]).toEqual(results[1])
      expect(yield* store.inThread(test.personalId)).toHaveLength(1)
      expect(yield* Ref.get((yield* Observation).notices)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('denial and withdrawal leave actions untouched and preserve the terminal cards', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const denied = yield* store.raise(test.vivid, connectionAction)
      const settled = yield* store.decide(test.personal, {
        id: denied.id,
        digest: denied.digest,
        decision: ApprovalDecision.cases.Deny.make({}),
      })
      expect(ApprovalState.guards.Denied(settled.state)).toBe(true)
      const withdrawn = yield* store.raise(test.vivid, connectionAction)
      yield* store.withdraw(test.personal, withdrawn.id)
      const records = yield* store.inThread(test.personalId)
      expect(records.map((row) => row.state._tag)).toEqual(
        expect.arrayContaining(['Denied', 'Withdrawn']),
      )
      expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )

  it.effect('inconsistent stored columns fail as DatabaseFailure', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const store = yield* ApprovalStore
      const approval = yield* store.raise(test.vivid, connectionAction)
      const database = yield* Database
      yield* database.run(
        database
          .update(approvals)
          .set({ status: 'succeeded' })
          .where(eq(approvals.id, approval.id)),
      )
      const result = yield* Effect.result(store.inThread(test.personalId))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DatabaseFailure)
    }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
