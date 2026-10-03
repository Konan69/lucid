import { eq, isNull, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  CompanyId,
  PersonId,
  PersonSummary,
  Skill,
  SkillId,
  SkillScope,
  SkillOrigin,
  Workspace,
} from '@vivid/contracts'
import { inWorkspace, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { skills } from './tables.ts'

const SkillRow = createSelectSchema(skills, {
  id: SkillId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
})
export type SkillRow = typeof SkillRow.Type
export const decodeSkillRow = decodeStored(SkillRow, 'Skill')
const decodePerson = decodeStored(PersonSummary, 'Skill owner')

/** Personal procedures follow their owner into every workspace; Company procedures stay there. */
export const visibleSkills = (actor: Actor) => {
  const personal = sql`${eq(skills.personId, actor.person.id)} AND ${isNull(skills.companyId)}`
  return Workspace.match(actor.workspace, {
    Personal: () => personal,
    Company: () => sql`(${personal}) OR (${inWorkspace(skills, actor)})`,
  })
}

/** Names belong to one Person's personal scope or one Company's shared scope. */
export const skillScope = (owner: Pick<SkillRow, 'personId' | 'companyId'>) =>
  owner.companyId === null
    ? sql`${eq(skills.personId, owner.personId)} AND ${isNull(skills.companyId)}`
    : eq(skills.companyId, owner.companyId)

/** Scope is derived from ownership columns and can never drift from persistence. */
export const scopeOf = (companyId: CompanyId | null) =>
  companyId === null ? SkillScope.cases.Personal.make({}) : SkillScope.cases.Company.make({})

/** A deleted owner cascades their procedures; a missing owner on a surviving row is a fault. */
export const projectSkill = Effect.fn('SkillStore.project')(function* (
  database: Database['Service'],
  row: SkillRow,
) {
  const people = yield* database.run(
    database
      .select({
        id: personTable.id,
        name: personTable.name,
        image: personTable.image,
      })
      .from(personTable)
      .where(eq(personTable.id, row.personId))
      .limit(1),
  )
  const createdBy = yield* decodePerson(yield* returned(people, 'Skill owner'))
  return Skill.make({
    id: row.id,
    about: row.about,
    name: row.name,
    useWhen: row.useWhen,
    instructions: row.instructions,
    scope: scopeOf(row.companyId),
    origin: SkillOrigin.cases.Saved.make({ createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
})
