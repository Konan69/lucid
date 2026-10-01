import { Schema } from 'effect'
import { PersonSummary, SkillId } from './identity.js'

/** Whose procedure it is: one Person's, or the Company's for everyone to use. */
export const SkillScope = Schema.TaggedUnion({
  Personal: {},
  Company: {},
})
export type SkillScope = typeof SkillScope.Type

/**
 * A saved procedure: how to do a piece of work the way this Person or Company does it. Storing one
 * does not schedule it; a Routine does that.
 */
export const Skill = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  /** When to use it, in a sentence. This is what Vivid matches a request against. */
  useWhen: Schema.String,
  /** The steps, decisions, expected result and what needs approval, as Markdown. */
  instructions: Schema.String,
  scope: SkillScope,
  createdBy: PersonSummary,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: 'Skill', title: 'Skill' })
export interface Skill extends Schema.Schema.Type<typeof Skill> {}

export const SaveSkillRequest = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  useWhen: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(300)),
  instructions: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20_000)),
  forCompany: Schema.Boolean,
})
export interface SaveSkillRequest extends Schema.Schema.Type<typeof SaveSkillRequest> {}

export const PatchSkillRequest = Schema.Struct({
  name: Schema.optionalKey(SaveSkillRequest.fields.name),
  useWhen: Schema.optionalKey(SaveSkillRequest.fields.useWhen),
  instructions: Schema.optionalKey(SaveSkillRequest.fields.instructions),
})
export interface PatchSkillRequest extends Schema.Schema.Type<typeof PatchSkillRequest> {}

/** What Vivid sees of each skill before choosing one: enough to pick, not the whole text. */
export const SkillSummary = Schema.Struct({
  id: SkillId,
  name: Schema.String,
  useWhen: Schema.String,
})
export interface SkillSummary extends Schema.Schema.Type<typeof SkillSummary> {}

export const SkillResponse = Schema.Struct({ skill: Skill })
export const SkillListResponse = Schema.Struct({ skills: Schema.Array(Skill) })
export const SkillSummaryListResponse = Schema.Struct({ skills: Schema.Array(SkillSummary) })
