import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Context } from 'effect'
import type { LoadedSkill } from './frontmatter.ts'

/** The catalogue heading matches the instructions that direct the model to Available Skills. */
export function skillsSection(skills: ReadonlyArray<LoadedSkill>) {
  return [
    '## Available Skills',
    '',
    'The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.',
    '',
    ...skills.map((skill) => `- **${skill.name}** — ${skill.description}`),
  ].join('\n')
}

/** Activation returns a known skill procedure or lists the available names. */
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

/** The catalogue and activation tool read only the bundled skills. An interrupted
 * activation may run again because it has no side effects. */
export const skillsExtension = (skills: ReadonlyArray<LoadedSkill>) =>
  defineExtension({
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

/**
 * The built-in skills, read from the installation once when the process starts: every Person's
 * conversations use the same catalogue, and a missing or malformed file stops startup.
 */
export class BuiltinSkills extends Context.Service<BuiltinSkills, Extension>()(
  'vivid/Runtime/BuiltinSkills',
) {}
