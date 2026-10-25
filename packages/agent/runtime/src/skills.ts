import * as NodeFSP from 'node:fs/promises'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { manifest } from '@vivid/skills'
import { Context, Effect, Layer, Schema } from 'effect'
import { parseSkill, type LoadedSkill } from './frontmatter.ts'

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

/**
 * The catalogue as the model reads it: Flue 2.2.2's wording and layout, line for line
 * (`composeSystemPrompt`, `dist/conversation-stream-store-*.mjs`). The instructions refer to
 * "Available Skills" by this heading.
 */
export function skillsSection(skills: ReadonlyArray<LoadedSkill>) {
  return [
    '## Available Skills',
    '',
    'The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.',
    '',
    ...skills.map((skill) => `- **${skill.name}** — ${skill.description}`),
  ].join('\n')
}

/**
 * What activation returns: Flue's packaged-skill prompt (`buildPackagedSkillPrompt`) for a known
 * name and its factual miss (`activateSkillForTool`) for an unknown one. No shipped skill has a
 * supporting file, so the resource list Flue would add is never present.
 */
export function activate(skills: ReadonlyArray<LoadedSkill>, name: string) {
  const skill = skills.find((entry) => entry.name === name)
  if (skill === undefined)
    return `Skill "${name}" is not available. Available skills: ${skills.map((entry) => entry.name).join(', ')}.`
  return [
    `Run the skill named "${name}".`,
    '',
    '<skill_instructions>',
    skill.body,
    '</skill_instructions>',
  ].join('\n')
}

export const ACTIVATE_SKILL = 'activate_skill'

/**
 * The built-in skills: the catalogue section and the one tool that loads a procedure. The tool's
 * name, description, parameter and details are Flue's (`createActivateSkillTool`,
 * `dist/result-*.mjs`). It only reads text the process loaded at startup, so a call a restart
 * interrupted may simply run again.
 */
export const skillsExtension = Effect.fn('Skills.extension')(function* () {
  const skills = yield* loadSkills()
  return defineExtension({
    name: 'skills',
    sections: [section('skills', () => skillsSection(skills), { tag: false })],
    tools: [
      defineTool({
        name: ACTIVATE_SKILL,
        description:
          'Load the full instructions for one available skill before performing work that matches its description. Supporting resources remain lazy until explicitly read.',
        parameters: Type.Object({
          name: Type.String({ description: 'Name of the skill to activate' }),
        }),
        replay: 'safe',
        // A procedure is returned whole or not at all; Pi's generic cut would end it mid-step.
        outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
        execute: (args) =>
          Promise.resolve({
            output: [{ type: 'text', text: activate(skills, args.name) }],
            details: { skill: args.name },
          }),
      }),
    ],
  })
})

/**
 * The built-in skills, read from the installation once when the process starts: every Person's
 * conversations use the same catalogue, and a missing or malformed file stops startup.
 */
export class BuiltinSkills extends Context.Service<BuiltinSkills, Extension>()(
  'vivid/Runtime/BuiltinSkills',
) {}

export const builtinSkillsLayer = Layer.effect(BuiltinSkills, skillsExtension())
