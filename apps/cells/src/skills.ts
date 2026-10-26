import { BuiltinSkills, extensionOf, parseSkill } from '@vivid/agent-runtime/cell'
import { manifest } from '@vivid/skills'
import { Effect, Layer, Schema } from 'effect'
import { texts } from './texts.ts'

/** The manifest names a skill whose text this bundle does not carry. */
export class SkillNotBundled extends Schema.TaggedError<SkillNotBundled>()(
  'SkillNotBundled',
  { name: Schema.String },
  { title: 'Skill text missing from the cell bundle' },
) {}

/**
 * The same built-in skills extension the Node process builds (`skills.ts` in the runtime), parsed
 * from the bundled texts instead of read from disk. Every manifest entry must have a text, and
 * each is parsed by the runtime's own `parseSkill`, so a malformed file stops the cell as it stops
 * the process.
 */
export const skillsLayer = Layer.effect(
  BuiltinSkills,
  Effect.gen(function* () {
    const loaded = yield* Effect.forEach(manifest, (entry) =>
      Effect.gen(function* () {
        const text = texts.get(entry.runtimeName)
        if (text === undefined) return yield* new SkillNotBundled({ name: entry.runtimeName })
        return yield* parseSkill(text, entry.runtimeName)
      }),
    )
    return extensionOf(loaded)
  }),
)
