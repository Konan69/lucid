import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  AuditEvent,
  Company,
  CompanyId,
  DatabaseConstraintViolation,
  DatabaseFailure,
  Forbidden,
  NotFound,
  RuleId,
  RuleScope,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { inArray } from 'drizzle-orm'
import { Effect, Layer, Match, Option } from 'effect'
import { fixture } from '../approvals/testing.ts'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { auditEntries } from '../audit/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { RuleStore, ruleStoreLayer } from './store.ts'
import { rules } from './tables.ts'

const testLayer = Layer.merge(ruleStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const decodeEvent = decodeStored(AuditEvent, 'audit event')
type Fixture = Effect.Success<ReturnType<typeof fixture>>

/** Read this fixture's persisted policy and decoded audit entries, independently of the live loader. */
const stored = Effect.fn('RuleAnnouncements.stored')(function* (test: Fixture) {
  const database = yield* Database
  const people = [test.personal.person.id, test.other.person.id]
  const rows = yield* database.run(
    database.select().from(rules).where(inArray(rules.personId, people)),
  )
  const audits = yield* database.run(
    database.select().from(auditEntries).where(inArray(auditEntries.personId, people)),
  )
  const events = yield* Effect.forEach(audits, (row) => decodeEvent(row.event))
  return { rows, audits, events }
})

/** Direct setup leaves no audit or notice, so removal observes only the operation under test. */
const seed = Effect.fn('RuleAnnouncements.seed')(function* (
  actor: Actor,
  companyId: CompanyId | null,
) {
  const database = yield* Database
  const id = RuleId.make(crypto.randomUUID())
  yield* database.run(
    database.insert(rules).values({
      id,
      personId: actor.person.id,
      companyId,
      action: 'Seeded policy',
      decision: 'Ask',
      createdAt: 0,
    }),
  )
  return id
})

/** A nonexistent Company is intentional here: only the real audit FK rejects this personal write. */
const failedAuditActor = (test: Fixture): Actor => ({
  ...test.personal,
  workspace: Workspace.cases.Company.make({
    company: Company.make({
      id: CompanyId.make(crypto.randomUUID()),
      name: 'Missing',
      slug: crypto.randomUUID(),
    }),
    role: 'member',
  }),
})

/** Successful behavior already exists through Audit.record; failures must also roll back policy. */
describe.skipIf(!testDatabaseConfigured)('Rule transaction announcements', () => {
  layer(testLayer)((it) => {
    it.effect('R1 personal create refreshes its owner in a Company workspace', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* RuleStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing(
          [Topic.person(test.personal.person.id)],
          store.list(test.member),
        )
        expect(observation.initial).toEqual([])
        const rule = yield* store.create(test.personal, {
          action: 'Personal policy',
          decision: 'Ask',
          scope: RuleScope.cases.Personal.make({}),
        })
        yield* payload(notifications, [Topic.person(test.personal.person.id)])
        expect(yield* nextValue(observation)).toEqual([rule])
        const state = yield* stored(test)
        expect(state.rows).toHaveLength(1)
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
          companyId: null,
          personId: test.personal.person.id,
          threadId: null,
          at: rule.createdAt,
        })
        expect(state.events).toEqual([
          AuditEvent.cases.RuleAdded.make({ action: rule.action, decision: rule.decision }),
        ])
      }).pipe(Effect.scoped),
    )
    it.effect('R2 Company create refreshes another Member and preserves audit audience', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const { company } = yield* requireAdmin(test.owner.workspace)
        const store = yield* RuleStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing([Topic.company(company.id)], store.list(test.member))
        expect(observation.initial).toEqual([])
        const rule = yield* store.create(test.owner, {
          action: 'Company policy',
          decision: 'Never',
          scope: RuleScope.cases.Company.make({}),
        })
        yield* payload(notifications, [
          Topic.company(company.id),
          Topic.person(test.owner.person.id),
        ])
        expect(yield* nextValue(observation)).toEqual([rule])
        const state = yield* stored(test)
        expect(state.rows).toHaveLength(1)
        expect(state.rows[0]).toMatchObject({
          companyId: company.id,
          personId: test.owner.person.id,
        })
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
          companyId: company.id,
          personId: test.owner.person.id,
          threadId: null,
          at: rule.createdAt,
        })
        expect(state.events).toEqual([
          AuditEvent.cases.RuleAdded.make({ action: rule.action, decision: rule.decision }),
        ])
      }).pipe(Effect.scoped),
    )
    it.effect('R3 allow refreshes personal policy with the actual Company Thread attribution', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const { company } = yield* requireAdmin(test.owner.workspace)
        // approvals/testing.ts calls its Company Thread id companyId; it is a ThreadId, not tenancy.
        const companyThreadId = test.companyId
        const actor: Actor = { ...test.member, threadId: Option.some(companyThreadId) }
        const store = yield* RuleStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing(
          [Topic.person(test.personal.person.id)],
          store.list(test.personal),
        )
        expect(observation.initial).toEqual([])
        const rule = yield* store.allow(actor, 'Approved exact action')
        yield* payload(notifications, [
          Topic.person(actor.person.id),
          Topic.company(company.id),
          Topic.thread(companyThreadId),
        ])
        expect(yield* nextValue(observation)).toEqual([rule])
        expect(rule.scope).toEqual(RuleScope.cases.Personal.make({}))
        expect(rule.decision).toBe('Allow')
        const state = yield* stored(test)
        expect(state.rows).toHaveLength(1)
        expect(state.rows[0]).toMatchObject({ companyId: null, personId: actor.person.id })
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
          companyId: company.id,
          threadId: companyThreadId,
          at: rule.createdAt,
        })
        expect(state.events).toEqual([
          AuditEvent.cases.RuleAdded.make({ action: rule.action, decision: 'Allow' }),
        ])
      }).pipe(Effect.scoped),
    )
    it.effect('R4 remove refreshes another Member and records one removal', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const { company } = yield* requireAdmin(test.owner.workspace)
        const id = yield* seed(test.owner, company.id)
        const store = yield* RuleStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing([Topic.company(company.id)], store.list(test.member))
        expect(observation.initial.map((rule) => rule.id)).toEqual([id])
        yield* store.remove(test.owner, id)
        yield* payload(notifications, [
          Topic.company(company.id),
          Topic.person(test.owner.person.id),
        ])
        expect(yield* nextValue(observation)).toEqual([])
        const state = yield* stored(test)
        expect(state.rows).toEqual([])
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
          companyId: company.id,
          personId: test.owner.person.id,
        })
        expect(state.events).toEqual([
          AuditEvent.cases.RuleRemoved.make({ action: 'Seeded policy' }),
        ])
      }).pipe(Effect.scoped),
    )
    it.effect('R5 denied and missing rules preserve rows, audit and silence', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const { company } = yield* requireAdmin(test.owner.workspace)
        const companyRule = yield* seed(test.owner, company.id)
        const personalRule = yield* seed(test.personal, null)
        const before = yield* stored(test)
        const store = yield* RuleStore
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* store
            .create(test.member, {
              action: 'Denied',
              decision: 'Ask',
              scope: RuleScope.cases.Company.make({}),
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(Forbidden)
        yield* silent(notifications)
        expect(yield* stored(test)).toEqual(before)
        expect(yield* store.remove(test.member, companyRule).pipe(Effect.flip)).toBeInstanceOf(
          Forbidden,
        )
        yield* silent(notifications)
        expect(yield* stored(test)).toEqual(before)
        for (const id of [personalRule, RuleId.make(crypto.randomUUID())]) {
          expect(yield* store.remove(test.owner, id).pipe(Effect.flip)).toEqual(
            new NotFound({ message: 'Rule not found' }),
          )
          yield* silent(notifications)
          expect(yield* stored(test)).toEqual(before)
        }
      }).pipe(Effect.scoped),
    )
    for (const operation of ['create', 'allow', 'remove'] as const) {
      it.effect(`R6 ${operation} rolls back policy when the real audit foreign key fails`, () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const actor = failedAuditActor(test)
          const store = yield* RuleStore
          const id =
            operation === 'remove'
              ? yield* seed(test.personal, null)
              : RuleId.make(crypto.randomUUID())
          const before = yield* stored(test)
          const notifications = yield* (yield* PgClient).listen(CHANNEL)
          const result = Match.value(operation).pipe(
            Match.when('create', () =>
              store
                .create(actor, {
                  action: 'Audit failure',
                  decision: 'Ask',
                  scope: RuleScope.cases.Personal.make({}),
                })
                .pipe(Effect.asVoid),
            ),
            Match.when('allow', () => store.allow(actor, 'Audit failure').pipe(Effect.asVoid)),
            Match.when('remove', () => store.remove(actor, id)),
            Match.exhaustive,
          )
          expect(yield* result.pipe(Effect.flip)).toEqual(
            new DatabaseConstraintViolation({ message: 'Database constraint was violated' }),
          )
          yield* silent(notifications)
          expect(yield* stored(test)).toEqual(before)
          if (operation === 'remove')
            expect((yield* store.list(test.personal)).map((rule) => rule.id)).toEqual([id])
        }).pipe(Effect.scoped),
      )
    }
    it.effect('R7 allow rolls back policy and audit after a genuine notice budget failure', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        // audit.thread_id is text without a FK; append succeeds before announcement rejects its size.
        const actor: Actor = {
          ...test.personal,
          threadId: Option.some(ThreadId.make('x'.repeat(8_000))),
        }
        const before = yield* stored(test)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(yield* (yield* RuleStore).allow(actor, 'Notice failure').pipe(Effect.flip)).toEqual(
          new DatabaseFailure({ message: 'Change notification exceeds its payload limit' }),
        )
        yield* silent(notifications)
        expect(yield* stored(test)).toEqual(before)
      }).pipe(Effect.scoped),
    )
    it.effect('R8 missing Vivid Thread attribution writes and announces nothing', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const actor: Actor = {
          ...test.personal,
          by: 'vivid',
          threadId: Option.none(),
          helper: Option.none(),
        }
        const before = yield* stored(test)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* (yield* RuleStore).allow(actor, 'Refused attribution').pipe(Effect.flip),
        ).toEqual(new DatabaseFailure({ message: 'Vivid audit attribution needs a Thread' }))
        yield* silent(notifications)
        expect(yield* stored(test)).toEqual(before)
      }).pipe(Effect.scoped),
    )
  })
})
