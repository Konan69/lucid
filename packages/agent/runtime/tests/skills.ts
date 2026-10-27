import * as NodeFSP from 'node:fs/promises'
import { manifest } from '@vivid/skills'
import { Effect, Layer, Schema } from 'effect'
import { parseSkill } from '../src/frontmatter.ts'
import { BuiltinSkills, skillsExtension } from '../src/skills.ts'

/** A shipped skill file is missing from the installation: a packaging fault, found at startup. */
export class SkillUnreadable extends Schema.TaggedError<SkillUnreadable>()(
  'SkillUnreadable',
  { name: Schema.String },
  { title: 'Shipped skill file unreadable' },
) {}

/** The package's exports own where the Markdown is, wherever the runtime is installed. */
const readSkill = Effect.fn('Skills.read')(function* (name: string) {
  return yield* Effect.tryPromise({
    try: () =>
      NodeFSP.readFile(new URL(import.meta.resolve(`@vivid/skills/${name}/SKILL.md`)), 'utf8'),
    catch: () => new SkillUnreadable({ name }),
  })
})

/** The manifest is the catalogue's order, the same for every Person and every response. */
export const loadSkills = Effect.fn('Skills.load')(function* () {
  return yield* Effect.forEach(manifest, (entry) =>
    readSkill(entry.runtimeName).pipe(
      Effect.flatMap((content) => parseSkill(content, entry.runtimeName)),
    ),
  )
})

export const builtinSkillsLayer = Layer.effect(
  BuiltinSkills,
  Effect.map(loadSkills(), skillsExtension),
)
