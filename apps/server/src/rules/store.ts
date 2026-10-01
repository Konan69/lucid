import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
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
import { Audit } from '../audit/record.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
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
const view = Effect.fn('Rules.view')(function* (values: ReadonlyArray<typeof rules.$inferSelect>) {
  const rows = yield* Effect.forEach(values, decodeRow)
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

/** One transaction owns a policy change and its audit record, including Always allow decisions. */
const insert = Effect.fn('Rules.insert')(function* (
  actor: Actor,
  action: string,
  decision: RuleDecision,
  companyId: CompanyId | null,
) {
  const database = yield* Database
  const audit = yield* Audit
  const row = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const rows = yield* tx
        .insert(rules)
        .values({
          id: NodeCrypto.randomUUID(),
          personId: actor.person.id,
          companyId,
          action,
          decision,
          createdAt: yield* Clock.currentTimeMillis,
        })
        .returning()
      yield* audit.record(actor, AuditEvent.cases.RuleAdded.make({ action, decision }))
      return yield* returned(rows, 'Rule')
    }),
  )
  return yield* returned(yield* view([row]), 'Rule')
})

/** Personal deletion checks ownership; Company deletion additionally checks the current admin role. */
const remove = Effect.fn('Rules.remove')(function* (actor: Actor, id: RuleId) {
  const database = yield* Database
  const audit = yield* Audit
  const rows = yield* database.run(
    database
      .select()
      .from(rules)
      .where(and(eq(rules.id, id), bindingRules(actor)))
      .limit(1),
  )
  const value = rows[0]
  if (value === undefined) return yield* Effect.fail(new NotFound({ message: 'Rule not found' }))
  const row = yield* decodeRow(value)
  if (row.companyId !== null) yield* requireAdmin(actor.workspace)
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const removed = yield* tx
        .delete(rules)
        .where(and(eq(rules.id, id), bindingRules(actor)))
        .returning()
      if (removed.length === 0)
        return yield* Effect.fail(new NotFound({ message: 'Rule not found' }))
      return yield* audit.record(actor, AuditEvent.cases.RuleRemoved.make({ action: row.action }))
    }),
  )
})

/** Owns binding policy and management, closing over database and audit authority once. */
export const ruleStoreLayer = Layer.effect(
  RuleStore,
  Effect.gen(function* () {
    const database = yield* Database
    const context = yield* Effect.context<Database | Audit>()
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
        return yield* view(rows).pipe(Effect.provideService(Database, database))
      }),
      /** Only admins write Company policy; personal policy has no Company column. */
      create: Effect.fn('RuleStore.create')(function* (actor, request) {
        if (RuleScope.guards.Personal(request.scope)) {
          return yield* Effect.provide(
            insert(actor, request.action, request.decision, null),
            context,
          )
        }
        const { company } = yield* requireAdmin(actor.workspace)
        return yield* Effect.provide(
          insert(actor, request.action, request.decision, company.id),
          context,
        )
      }),
      /** An Approval's exact summary becomes personal Allow policy; no management scope is inferred. */
      allow: Effect.fn('RuleStore.allow')(function* (actor, action) {
        return yield* Effect.provide(insert(actor, action, 'Allow', null), context)
      }),
      remove: (actor, id) => Effect.provide(remove(actor, id), context),
    })
  }),
)
