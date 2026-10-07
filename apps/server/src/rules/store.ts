import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Array from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  AuditEvent,
  CompanyId,
  DatabaseFailure,
  NotFound,
  PersonId,
  Rule,
  RuleDecision,
  RuleId,
  RuleScope,
  type CreateRuleRequest,
  type Forbidden,
} from '@vivid/contracts'
import { companyOf, loadSummaries, requireAdmin, type Actor } from '../auth/access.ts'
import { appendAudit, attributionOf, auditTopics } from '../audit/record.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { rules } from './tables.ts'

const Row = createSelectSchema(rules, {
  id: RuleId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  decision: RuleDecision,
})
const decodeRow = decodeStored(Row, 'Rule')

/** Personal rules follow their owner into every workspace; Company rules bind every Member. */
const bindingRules = (actor: Actor) => {
  const mine = and(eq(rules.personId, actor.person.id), isNull(rules.companyId))
  return Option.match(companyOf(actor.workspace), {
    onNone: () => mine,
    onSome: (company) => or(mine, eq(rules.companyId, company.id)),
  })
}

/** Projects ownership into the fixed wire scope, failing if the recorded author is absent. */
const view = Effect.fn('Rules.view')(function* (rows: ReadonlyArray<typeof Row.Type>) {
  const people = yield* loadSummaries(rows.map((row) => row.personId))
  return yield* Effect.forEach(rows, (row) => {
    const person = people.get(row.personId)
    if (person === undefined)
      return Effect.fail(new DatabaseFailure({ message: 'Rule author is missing' }))
    return Effect.succeed(
      Rule.make({
        id: row.id,
        action: row.action,
        decision: row.decision,
        scope:
          row.companyId === null
            ? RuleScope.cases.Personal.make({})
            : RuleScope.cases.Company.make({}),
        createdBy: person,
        createdAt: row.createdAt,
      }),
    )
  })
})

export interface RuleStoreService {
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Rule>, DatabaseInfrastructureError>
  readonly create: (
    actor: Actor,
    request: CreateRuleRequest,
  ) => Effect.Effect<Rule, Forbidden | DatabaseInfrastructureError>
  readonly allow: (actor: Actor, action: string) => Effect.Effect<Rule, DatabaseInfrastructureError>
  readonly remove: (
    actor: Actor,
    id: RuleId,
  ) => Effect.Effect<void, NotFound | Forbidden | DatabaseInfrastructureError>
}
export class RuleStore extends Context.Service<RuleStore, RuleStoreService>()('vivid/RuleStore') {}

/** A policy's stored owner defines its audience independently of the request's audit attribution. */
const ruleTopics = (row: typeof Row.Type): ReadonlyArray<Topic> =>
  row.companyId === null ? [Topic.person(row.personId)] : [Topic.company(row.companyId)]

/**
 * Policy, audit/record.ts appendAudit and live/changes.ts announce share one writing transaction.
 * A failed author projection, audit or notice leaves no policy. The root Database read in view
 * joins tx through Drizzle EffectPgSession.transaction and rc.116 SqlClient.make's fiber context.
 */
const makeInsert = (database: Database['Service']) =>
  Effect.fn('Rules.insert')(function* (
    actor: Actor,
    action: string,
    decision: RuleDecision,
    companyId: CompanyId | null,
  ) {
    const attribution = yield* attributionOf(actor)
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .insert(rules)
          .values({
            id: NodeCrypto.randomUUID(),
            personId: actor.person.id,
            companyId,
            action,
            decision,
            createdAt: now,
          })
          .returning()
        const row = yield* decodeRow(yield* returned(rows, 'Rule'))
        const rule = yield* returned(
          yield* view([row]).pipe(Effect.provideService(Database, database)),
          'Rule',
        )
        yield* appendAudit(
          tx,
          attribution,
          AuditEvent.cases.RuleAdded.make({ action, decision }),
          now,
        )
        yield* announce(tx, Array.dedupe([...ruleTopics(row), ...auditTopics(attribution)]))
        return rule
      }),
    )
  })

/**
 * Lock the same visible policy that authorization judges; removal, audit/record.ts appendAudit and
 * live/changes.ts announce commit together. Refusal or any later failure preserves the locked row.
 */
const makeRemove = (database: Database['Service']) =>
  Effect.fn('Rules.remove')(function* (actor: Actor, id: RuleId) {
    const attribution = yield* attributionOf(actor)
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(rules)
          .where(and(eq(rules.id, id), bindingRules(actor)))
          .limit(1)
          .for('update')
        const value = rows[0]
        if (value === undefined) return yield* new NotFound({ message: 'Rule not found' })
        const row = yield* decodeRow(value)
        if (row.companyId !== null) yield* requireAdmin(actor.workspace)
        yield* tx.delete(rules).where(eq(rules.id, id))
        yield* appendAudit(
          tx,
          attribution,
          AuditEvent.cases.RuleRemoved.make({ action: row.action }),
          now,
        )
        yield* announce(tx, Array.dedupe([...ruleTopics(row), ...auditTopics(attribution)]))
      }),
    )
  })

/** Owns binding policy and management with Database as its only captured authority. */
export const ruleStoreLayer = Layer.effect(
  RuleStore,
  Effect.gen(function* () {
    const database = yield* Database
    const insert = makeInsert(database)
    const remove = makeRemove(database)
    return RuleStore.of({
      /** Personal policy is loaded in every workspace, alongside that Company's policy. */
      list: Effect.fn('RuleStore.list')(function* (actor) {
        const rows = yield* database.run(
          database
            .select()
            .from(rules)
            .where(bindingRules(actor))
            .orderBy(asc(rules.createdAt), asc(rules.id)),
        )
        return yield* view(yield* Effect.forEach(rows, decodeRow)).pipe(
          Effect.provideService(Database, database),
        )
      }),
      /** Only admins write Company policy; personal policy has no Company column. */
      create: Effect.fn('RuleStore.create')(function* (actor, request) {
        if (RuleScope.guards.Personal(request.scope)) {
          return yield* insert(actor, request.action, request.decision, null)
        }
        const { company } = yield* requireAdmin(actor.workspace)
        return yield* insert(actor, request.action, request.decision, company.id)
      }),
      /** An Approval's exact summary becomes personal Allow policy; no management scope is inferred. */
      allow: Effect.fn('RuleStore.allow')(function* (actor, action) {
        return yield* insert(actor, action, 'Allow', null)
      }),
      remove,
    })
  }),
)
