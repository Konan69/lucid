import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Context, Option, Schema } from 'effect'
import type { LoadedSkill } from './frontmatter.ts'

export const ACTIVATE_SKILL = 'activate_skill'
export const READ_SKILL_FILE = 'read_skill_file'

/** The catalogue heading matches the instructions that direct the model to Available Skills. */
function skillsSection(skills: ReadonlyArray<LoadedSkill>) {
  return [
    '## Available Skills',
    '',
    'The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.',
    '',
    ...skills.map((skill) => `- **${skill.name}** — ${skill.description}`),
  ].join('\n')
}

/**
 * Activation returns a known skill procedure or lists the available names. A name that is not a
 * built-in may be a saved procedure, which only `read_skill` reads: on 29 October 2026 a model
 * activated a procedure a Person had taught it, was told only that it was not available, and wrote
 * the task without its rules. So the refusal says where saved procedures are read, as `read_skill`
 * says where built-ins are activated (`tools/skills.ts`).
 */
function activate(skills: ReadonlyArray<LoadedSkill>, name: string) {
  const skill = skills.find((entry) => entry.name === name)
  if (skill === undefined)
    return `Skill "${name}" is not a built-in skill. If it is a saved procedure from your response context, read it with read_skill and follow it. Built-in skills: ${skills.map((entry) => entry.name).join(', ')}.`
  return [
    `Run the skill named "${name}".`,
    '',
    '<skill_instructions>',
    skill.body,
    ...references(skill),
    '</skill_instructions>',
  ].join('\n')
}

/** After the body, each reference file by name with its first line, so the model knows what it can
 * read and when; the heading marks of that line are dropped. Nothing when the skill has none. */
function references(skill: LoadedSkill) {
  if (skill.files.length === 0) return []
  return [
    '',
    `Reference files. Read one with ${READ_SKILL_FILE} when a step needs it:`,
    ...skill.files.map(
      (file) =>
        `- ${file.name}: ${file.body
          .split('\n', 1)
          .join('')
          .replace(/^#+\s*/u, '')}`,
    ),
  ]
}

/** The named skill ships no file by that name; `files` is what it does ship, to choose from. */
export class SkillFileMissing extends Schema.TaggedError<SkillFileMissing>()(
  'SkillFileMissing',
  { skill: Schema.String, file: Schema.String, files: Schema.Array(Schema.String) },
  { title: 'Skill reference file missing' },
) {}
const encodeFileMissing = Schema.encodeOption(SkillFileMissing)

/** One reference file's contents, or the refusal the model reads: the sentence always, and the
 * typed error beside it when it encodes, as `read_skill` refuses (`tools/skills.ts`). An unknown
 * skill gets activation's own answer, which lists the names. */
function readFile(skills: ReadonlyArray<LoadedSkill>, name: string, path: string) {
  const skill = skills.find((entry) => entry.name === name)
  if (skill === undefined) return activate(skills, name)
  const file = skill.files.find((entry) => entry.name === path)
  if (file !== undefined) return file.body
  const files = skill.files.map((entry) => entry.name)
  const message =
    files.length === 0
      ? `Skill "${name}" has no reference files.`
      : `Skill "${name}" has no file "${path}". Its files: ${files.join(', ')}.`
  return JSON.stringify(
    Option.match(encodeFileMissing(new SkillFileMissing({ skill: name, file: path, files })), {
      onNone: () => ({ ok: false, message }),
      onSome: (error) => ({ ok: false, error, message }),
    }),
  )
}

/** The catalogue, activation and reference reads use only the bundled skills. An interrupted
 * activation or read may run again because neither has side effects. */
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
      defineTool({
        name: READ_SKILL_FILE,
        description:
          'Read one reference file of an activated built-in skill, by the skill name and the file path its instructions list (references/<file>.md). Saved procedures have no files; use read_skill for those.',
        parameters: Type.Object({
          skill: Type.String({ description: 'Name of the activated skill' }),
          file: Type.String({ description: 'Path of the file, as the skill lists it' }),
        }),
        replay: 'safe',
        // A reference is returned whole, like the procedure that points at it.
        outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
        execute: (args) =>
          Promise.resolve({
            output: [{ type: 'text', text: readFile(skills, args.skill, args.file) }],
            details: { skill: args.skill, file: args.file },
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
