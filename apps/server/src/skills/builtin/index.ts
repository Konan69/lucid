import { Skill, SkillId, SkillOrigin, SkillScope } from '@vivid/contracts'
import { manifest, builtinId } from '../../../../../packages/agent/skills/src/manifest.ts'
import { readMarkdown } from './markdown.ts'

/** The release date remains stable evidence for the unchanged built-in wire records. */
const releasedAt = Date.UTC(2026, 9, 2)

/** SKILL.md is the only source of descriptions and bodies; the manifest owns product metadata. */
export const procedures = manifest.map((entry) => {
  const skill = readMarkdown(entry.runtimeName)
  return {
    runtimeName: entry.runtimeName,
    displayName: entry.displayName,
    about: entry.about,
    starter: entry.starter,
    needs: entry.needs,
    connections: entry.connections,
    name: entry.displayName,
    useWhen: skill.description,
    instructions: skill.instructions,
  }
})

/** Deterministic shipped identities are private lookup handles; runtime views project only words. */
export const builtins = procedures.map((procedure) =>
  Skill.make({
    id: SkillId.make(builtinId(procedure.name)),
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

/** Name resolution folds case and whitespace just as the model's name inventory does. */
const key = (name: string) => name.trim().toLowerCase()

/** Saved visible procedures replace shipped names only inside the actor's readable scope. */
export const catalogue = (saved: ReadonlyArray<Skill>): ReadonlyArray<Skill> => {
  const overrides = new Set(saved.map((skill) => key(skill.name)))
  return [...saved, ...builtins.filter((skill) => !overrides.has(key(skill.name)))]
}

/** The summary makes precedence explicit without transporting attribution or instructions. */
export const summary = (skill: Skill) => {
  if (SkillScope.guards.BuiltIn(skill.scope))
    return `${skill.useWhen} Built into Vivid; a saved procedure of this name takes precedence for its Person or Company.`
  if (builtins.some((builtin) => key(builtin.name) === key(skill.name)))
    return `${skill.useWhen} This saved procedure overrides Vivid's built-in procedure for its Person or Company.`
  return skill.useWhen
}
