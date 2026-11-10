import { Skill, SkillOrigin, SkillScope } from '@vivid/contracts'
import { manifest, builtinId } from '@vivid/skills'
import { readMarkdown } from '@vivid/skills/markdown'
import { Result } from 'effect'

/** The release date remains stable evidence for the unchanged built-in wire records. */
const releasedAt = Date.UTC(2026, 9, 2)

/** SKILL.md is the only source of descriptions and bodies; the manifest owns product metadata. */
const procedures = manifest.map((entry) => {
  const skill = Result.getOrThrow(readMarkdown(entry.runtimeName))
  return {
    runtimeName: entry.runtimeName,
    displayName: entry.displayName,
    about: entry.about,
    starter: entry.starter,
    needs: entry.needs,
    connections: entry.connections,
    name: entry.displayName,
    useWhen: skill.description,
    instructions: skill.body,
  }
})

/** Deterministic shipped identities are private lookup handles; runtime views project only words. */
export const builtins = procedures.map((procedure) =>
  Skill.make({
    id: builtinId(procedure.name),
    about: procedure.about,
    name: procedure.name,
    useWhen: procedure.useWhen,
    instructions: procedure.instructions,
    scope: SkillScope.cases.BuiltIn.make({}),
    origin: SkillOrigin.cases.BuiltIn.make({}),
    createdAt: releasedAt,
    updatedAt: releasedAt,
  }),
)

/** Shipped procedures are always present; saved procedures never replace a built-in. */
export const catalogue = (saved: ReadonlyArray<Skill>): ReadonlyArray<Skill> => [
  ...saved,
  ...builtins,
]

/** Summaries disclose routing text only; there is no Person-facing installation or override policy. */
export const summary = (skill: Skill) => skill.useWhen
