import { Schema } from 'effect'
import { PersonSummary, SkillId } from './identity.js'

/** Procedures are personal, shared by a Company, or shipped with Vivid. */
export const SkillScope = Schema.TaggedUnion({
  Personal: {},
  Company: {},
  BuiltIn: {},
})
export type SkillScope = typeof SkillScope.Type

/** Built-ins have no human author; saved procedures preserve real attribution. */
export const SkillOrigin = Schema.TaggedUnion({
  Saved: { createdBy: PersonSummary },
  BuiltIn: {},
})
export type SkillOrigin = typeof SkillOrigin.Type

/**
 * A saved procedure: how to do a piece of work the way this Person or Company does it. Storing one
 * does not arrange future work.
 */
const content = {
  id: SkillId,
  name: Schema.String,
  /** One sentence to you about what it does for you, without tool names or model instructions. */
  about: Schema.String,
  /** When to use it, in a sentence. This is what Vivid matches a request against. */
  useWhen: Schema.String,
  /** The steps, decisions, expected result and what needs approval, as Markdown. */
  instructions: Schema.String,

  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}
/** Origin and scope agree by construction; a shipped procedure cannot acquire a fabricated creator. */
export const Skill = Schema.Union([
  Schema.Struct({
    ...content,
    scope: Schema.Union([SkillScope.cases.Personal, SkillScope.cases.Company]),
    origin: SkillOrigin.cases.Saved,
  }),
  Schema.Struct({ ...content, scope: SkillScope.cases.BuiltIn, origin: SkillOrigin.cases.BuiltIn }),
]).annotate({ identifier: 'Skill', title: 'Skill' })
export type Skill = typeof Skill.Type

export const SaveSkillRequest = Schema.Struct({
  about: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(300)),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  useWhen: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(300)),
  instructions: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20_000)),
  forCompany: Schema.Boolean,
})
export interface SaveSkillRequest extends Schema.Schema.Type<typeof SaveSkillRequest> {}

/** What Vivid sees of each skill before choosing one: enough to pick, not the whole text. */
export const SkillSummary = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  useWhen: Schema.String,
  /** Immutable order keeps duplicate display names stable without loading instructions. */
  createdAt: content.createdAt,
})
export interface SkillSummary extends Schema.Schema.Type<typeof SkillSummary> {}

export const SkillResponse = Schema.Struct({ skill: Skill })
export const SkillListResponse = Schema.Struct({ skills: Schema.Array(Skill) })
export const SkillSummaryListResponse = Schema.Struct({ skills: Schema.Array(SkillSummary) })
