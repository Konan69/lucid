import * as NodeFSP from 'node:fs/promises'
import { manifest } from '@vivid/skills'
import { Array as Arr, Effect, Layer, Order, Schema } from 'effect'
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

/** Every `references/*.md` beside the skill's SKILL.md, in name order; a skill whose folder has no
 * `references` directory ships none. A read failure is the same packaging fault as an unreadable
 * SKILL.md. */
const readFiles = Effect.fn('Skills.readFiles')(function* (name: string) {
  const skill = new URL('./', import.meta.resolve(`@vivid/skills/${name}/SKILL.md`))
  const folder = new URL('references/', skill)
  const unreadable = () => new SkillUnreadable({ name })
  const entries = yield* Effect.tryPromise({
    try: () =>
      NodeFSP.readdir(skill).then((found) =>
        found.includes('references') ? NodeFSP.readdir(folder) : [],
      ),
    catch: unreadable,
  })
  return yield* Effect.forEach(
    Arr.sort(
      entries.filter((entry) => entry.endsWith('.md')),
      Order.String,
    ),
    (entry) =>
      Effect.tryPromise({
        try: () => NodeFSP.readFile(new URL(entry, folder), 'utf8'),
        catch: unreadable,
      }).pipe(Effect.map((body) => ({ name: `references/${entry}`, body }))),
  )
})

/** The manifest is the catalogue's order, the same for every Person and every response. */
export const loadSkills = Effect.fn('Skills.load')(function* () {
  return yield* Effect.forEach(manifest, (entry) =>
    Effect.all([readSkill(entry.runtimeName), readFiles(entry.runtimeName)]).pipe(
      Effect.flatMap(([content, files]) => parseSkill(content, entry.runtimeName, files)),
    ),
  )
})

export const builtinSkillsLayer = Layer.effect(
  BuiltinSkills,
  Effect.map(loadSkills(), skillsExtension),
)
