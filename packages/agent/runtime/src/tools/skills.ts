import { defineTool } from '@flue/runtime'
import { Effect, Option, Schema } from 'effect'
import { builtinNamed, manifest } from '@vivid/skills'
import * as v from 'valibot'
import { text } from './inputs.ts'
import { savedInventory, named, NameMissing } from './names.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

const RuntimeName = Schema.Literals(manifest.map((entry) => entry.runtimeName))
const reservedMessage = 'that name belongs to a built-in skill; choose another name'

/** Built-in names are a permanent release vocabulary, never a saved-procedure override key. */
export class BuiltinSkillNameReserved extends Schema.TaggedError<BuiltinSkillNameReserved>()(
  'BuiltinSkillNameReserved',
  { runtimeName: RuntimeName, message: Schema.Literal(reservedMessage) },
  { title: 'Built-in skill name reserved' },
) {}

/** Old read_skill calls get a precise route to native activation instead of a generic missing-name loop. */
export class BuiltinSkillActivationRequired extends Schema.TaggedError<BuiltinSkillActivationRequired>()(
  'BuiltinSkillActivationRequired',
  { runtimeName: RuntimeName, tool: Schema.Literal('activate_skill') },
  { title: 'Built-in skill requires native activation' },
) {}
const encodeReserved = Schema.encodeSync(BuiltinSkillNameReserved)
const encodeActivation = Schema.encodeSync(BuiltinSkillActivationRequired)

/** Saved procedures resolve only within the acting Person's catalog; storage never schedules work. */
export function skillTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'read_skill',
      description:
        'Read a saved procedure by its exact name from context before following its steps. Built-ins use activate_skill.',
      input: v.object({ name: text('The procedure name shown in context.', 100) }),
      /** The catalog and view share names, so duplicates never select an arbitrary procedure. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const builtin = builtinNamed(data.name)
            if (Option.isSome(builtin))
              return yield* Effect.fail(
                new BuiltinSkillActivationRequired({
                  runtimeName: builtin.value.runtimeName,
                  tool: 'activate_skill',
                }),
              )
            const { client } = yield* Scope
            const { skills } = yield* client.ListSkillSummaries()
            const entries = savedInventory(skills, (item) => views.modelText(item.name))
            const found = yield* Effect.fromResult(named(entries, data.name))
            const response = yield* client.ReadSkill({ id: found.id })
            const entry = entries.find(({ item }) => item.id === found.id)
            if (entry === undefined) return yield* Effect.fail(new NameMissing({ name: data.name }))
            return { output: views.skill(response.skill, entry.name) }
          }).pipe(
            Effect.catchTag('BuiltinSkillActivationRequired', (error) =>
              Effect.succeed({
                output: {
                  ok: false,
                  error: encodeActivation(error),
                  message: `Use activate_skill with ${error.runtimeName}.`,
                },
              }),
            ),
          ),
          { signal, tool: 'read_skill' },
        )
      },
    }),
    defineTool({
      name: 'save_skill',
      description:
        'Save a verified reusable procedure for yourself whenever it will help future work. Do not ask a person to create or manage a skill. Include decisions and approval needs; saving does not create a Routine.',
      input: v.object({
        name: text('A lowercase-hyphen runtime name; built-in names are reserved.', 80),
        about: text('One sentence describing the work this procedure does.', 300),
        useWhen: text('When to use this procedure, in one sentence.', 300),
        instructions: text(
          'Steps, decisions, expected result and approval needs in Markdown.',
          20_000,
        ),
        // Vivid chooses procedure scope itself; the server still enforces Company write authority.
        forCompany: v.pipe(
          v.boolean(),
          v.description(
            'True for shared Company working knowledge within Company permissions; false for personal procedures.',
          ),
        ),
      }),
      /** Refresh catalog naming after storage so the returned name can be used by read_skill. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const builtin = builtinNamed(data.name)
            if (Option.isSome(builtin))
              return yield* Effect.fail(
                new BuiltinSkillNameReserved({
                  runtimeName: builtin.value.runtimeName,
                  message: reservedMessage,
                }),
              )
            const { client } = yield* Scope
            const response = yield* client.SaveSkill(data)
            const { skills } = yield* client.ListSkillSummaries()
            const entry = savedInventory(skills, (item) => views.modelText(item.name)).find(
              ({ item }) => item.id === response.skill.id,
            )
            if (entry === undefined) return yield* Effect.fail(new NameMissing({ name: data.name }))
            return { output: views.skillSummary(response.skill, entry.name) }
          }).pipe(
            Effect.catchTag('BuiltinSkillNameReserved', (error) =>
              Effect.succeed({
                output: { ok: false, error: encodeReserved(error), message: error.message },
              }),
            ),
          ),
          { signal, tool: 'save_skill' },
        )
      },
    }),
  ] as const
}
