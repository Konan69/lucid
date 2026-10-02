import * as NodeCrypto from 'node:crypto'
import { asc, desc, eq, ne, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  SkillId,
  SkillScope,
  SkillReadOnly,
  type Skill,
  type SaveSkillRequest,
  type PatchSkillRequest,
  Forbidden,
} from '@vivid/contracts'
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
export class SkillMissing extends Schema.TaggedError<SkillMissing>()(
  'SkillMissing',
  { id: SkillId },
  { title: 'Skill not found' },
) {}
/** Being able to use a procedure does not grant permission to change it. */
export class SkillNotEditable extends Schema.TaggedError<SkillNotEditable>()(
  'SkillNotEditable',
  { id: SkillId },
  { title: 'Skill edit denied' },
) {}
/** Name collisions are scoped: personal and Company procedures may share a name. */
export class SkillNameTaken extends Schema.TaggedError<SkillNameTaken>()(
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
  | SkillNotEditable
  | SkillNameTaken
  | SkillReadOnly
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

export interface SkillStoreService {
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Skill>, DatabaseInfrastructureError>
  readonly read: (actor: Actor, id: SkillId) => Effect.Effect<Skill, SkillStoreError>
  readonly save: (actor: Actor, request: SaveSkillRequest) => Effect.Effect<Skill, SkillStoreError>
  readonly patch: (
    actor: Actor,
    id: SkillId,
    patch: PatchSkillRequest,
  ) => Effect.Effect<Skill, SkillStoreError>
  readonly remove: (actor: Actor, id: SkillId) => Effect.Effect<void, SkillStoreError>
}
export class SkillStore extends Context.Service<SkillStore, SkillStoreService>()(
  'vivid/SkillStore',
) {}

/** Authorize against the readable row first, so foreign identifiers always remain NotFound. */
const editable = Effect.fn('SkillStore.editable')(function* (actor: Actor, row: SkillRow) {
  if (row.personId === actor.person.id) return
  if (row.companyId === null) yield* Effect.fail(new SkillNotEditable({ id: row.id }))
  yield* requireAdmin(actor.workspace).pipe(
    Effect.mapError(() => new SkillNotEditable({ id: row.id })),
  )
})

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
    yield* Effect.fail(new SkillNameTaken({ id, name, scope: scopeOf(owner.companyId) }))
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
  if (row === undefined) return yield* Effect.fail(new SkillMissing({ id }))
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

/** Renames share the save lock; column updates preserve fields omitted from the patch. */
const makePatch = (database: Database['Service']) =>
  Effect.fn('SkillStore.patch')(function* (actor: Actor, id: SkillId, patch: PatchSkillRequest) {
    if (builtins.some((skill) => skill.id === id))
      return yield* Effect.fail(new SkillReadOnly({ id }))
    const original = yield* loadRow(database, actor, id)
    yield* editable(actor, original)
    const now = yield* Clock.currentTimeMillis
    const row = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* lockScope(tx, original)
        if (patch.name !== undefined) yield* uniqueName(tx, original, patch.name, id)
        const rows = yield* tx
          .update(skills)
          .set({
            name: patch.name,
            useWhen: patch.useWhen,
            instructions: patch.instructions,
            updatedAt: now,
          })
          .where(sql`(${visibleSkills(actor)}) AND ${eq(skills.id, id)}`)
          .returning()
        const updated = rows[0]
        if (updated === undefined) return yield* Effect.fail(new SkillMissing({ id }))
        return yield* decodeSkillRow(updated)
      }),
    )
    return yield* projectSkill(database, row)
  })

/** Delete confirms visibility and authority before touching the row, even for Company admins. */
const makeRemove = (database: Database['Service']) =>
  Effect.fn('SkillStore.remove')(function* (actor: Actor, id: SkillId) {
    if (builtins.some((skill) => skill.id === id)) yield* Effect.fail(new SkillReadOnly({ id }))
    const row = yield* loadRow(database, actor, id)
    yield* editable(actor, row)
    const removed = yield* database.run(
      database
        .delete(skills)
        .where(sql`(${visibleSkills(actor)}) AND ${eq(skills.id, id)}`)
        .returning({ id: skills.id }),
    )
    if (removed.length === 0) yield* Effect.fail(new SkillMissing({ id }))
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
      patch: makePatch(database),
      remove: makeRemove(database),
    })
  }),
)
