import * as NodeCrypto from 'node:crypto'
import { asc, desc, eq, ne, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SkillId, SkillScope, type Skill, type SaveSkillRequest, Forbidden } from '@vivid/contracts'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { Database, returned, type DatabaseInfrastructureError } from '../database/client.ts'
import {
  decodeSkillRow,
  projectSkill,
  scopeOf,
  skillScope,
  visibleSkills,
  type SkillRow,
} from './records.ts'
import { skills } from './tables.ts'
import { builtins, catalogue } from './builtin/index.ts'

/** An inaccessible identifier must reveal nothing about another scope. */
class SkillMissing extends Schema.TaggedError<SkillMissing>()(
  'SkillMissing',
  { id: SkillId },
  { title: 'Skill not found' },
) {}
/** Name collisions are scoped: personal and Company procedures may share a name. */
class SkillNameTaken extends Schema.TaggedError<SkillNameTaken>()(
  'SkillNameTaken',
  {
    id: SkillId,
    name: Schema.String,
    scope: SkillScope,
  },
  { title: 'Skill name conflict' },
) {}
export type SkillStoreError =
  | DatabaseInfrastructureError
  | Forbidden
  | SkillMissing
  | SkillNameTaken
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

export interface SkillStoreService {
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Skill>, DatabaseInfrastructureError>
  readonly read: (actor: Actor, id: SkillId) => Effect.Effect<Skill, SkillStoreError>
  readonly save: (actor: Actor, request: SaveSkillRequest) => Effect.Effect<Skill, SkillStoreError>
}
export class SkillStore extends Context.Service<SkillStore, SkillStoreService>()(
  'vivid/SkillStore',
) {}

/** The fixed table has no unique scope index; all name writers serialize on the scope in SQL. */
const lockScope = Effect.fn('SkillStore.lockScope')(function* (
  tx: Transaction,
  owner: Pick<SkillRow, 'personId' | 'companyId'>,
) {
  const key =
    owner.companyId === null
      ? `skills:person:${owner.personId}`
      : `skills:company:${owner.companyId}`
  yield* tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
})

/** The name check runs after the scope lock, including renames, to prevent concurrent duplicates. */
const uniqueName = Effect.fn('SkillStore.uniqueName')(function* (
  tx: Transaction,
  owner: Pick<SkillRow, 'personId' | 'companyId'>,
  name: string,
  id: SkillId,
) {
  const collisions = yield* tx
    .select({ id: skills.id })
    .from(skills)
    .where(sql`(${skillScope(owner)}) AND ${eq(skills.name, name)} AND ${ne(skills.id, id)}`)
    .limit(1)
  if (collisions.length > 0)
    return yield* new SkillNameTaken({ id, name, scope: scopeOf(owner.companyId) })
})

/** Reads and writes use the same visibility condition, including personal skills in a Company. */
const loadRow = Effect.fn('SkillStore.loadRow')(function* (
  database: Database['Service'],
  actor: Actor,
  id: SkillId,
) {
  const rows = yield* database.run(
    database
      .select()
      .from(skills)
      .where(sql`(${visibleSkills(actor)}) AND ${eq(skills.id, id)}`)
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined) return yield* new SkillMissing({ id })
  return yield* decodeSkillRow(row)
})

/** Company publication needs administration; a personal save never inherits the active Company. */
const makeSave = (database: Database['Service']) =>
  Effect.fn('SkillStore.save')(function* (actor: Actor, request: SaveSkillRequest) {
    const companyId = request.forCompany ? (yield* requireAdmin(actor.workspace)).company.id : null
    const id = SkillId.make(NodeCrypto.randomUUID())
    const now = yield* Clock.currentTimeMillis
    const owner = { personId: actor.person.id, companyId }
    const row = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* lockScope(tx, owner)
        yield* uniqueName(tx, owner, request.name, id)
        const rows = yield* tx
          .insert(skills)
          .values({
            id,
            personId: owner.personId,
            companyId,
            about: request.about,
            name: request.name,
            useWhen: request.useWhen,
            instructions: request.instructions,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return yield* decodeSkillRow(yield* returned(rows, 'Skill'))
      }),
    )
    return yield* projectSkill(database, row)
  })

/** Decode and project each persisted row at the owning database boundary. */
const makeProjection = (database: Database['Service']) =>
  Effect.fn('SkillStore.decode')(function* (row: typeof skills.$inferSelect) {
    return yield* projectSkill(database, yield* decodeSkillRow(row))
  })

/** Persistence is acquired once; Actor authority remains explicit on every operation. */
export const skillStoreLayer = Layer.effect(
  SkillStore,
  Effect.gen(function* () {
    const database = yield* Database
    return SkillStore.of({
      /** Ordering is stable when procedures share an update timestamp. */
      list: Effect.fn('SkillStore.list')(function* (actor) {
        const rows = yield* database.run(
          database
            .select()
            .from(skills)
            .where(visibleSkills(actor))
            .orderBy(desc(skills.updatedAt), asc(skills.id)),
        )
        return catalogue(yield* Effect.forEach(rows, makeProjection(database)))
      }),
      /** Projection only happens after the identifier has passed scope filtering. */
      read: Effect.fn('SkillStore.read')(function* (actor, id) {
        const builtin = builtins.find((skill) => skill.id === id)
        if (builtin !== undefined) return builtin
        return yield* projectSkill(database, yield* loadRow(database, actor, id))
      }),
      save: makeSave(database),
    })
  }),
)
