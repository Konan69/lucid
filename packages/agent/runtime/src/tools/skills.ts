import { defineTool } from '@flue/runtime'
import { Effect } from 'effect'
import * as v from 'valibot'
import { forCompany, text } from './inputs.ts'
import { inventory, named, NameMissing } from './names.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** Saved procedures resolve only within the acting Person's catalog; storage never schedules work. */
export function skillTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'read_skill',
      description:
        'Read a saved procedure by its exact name from context before following its steps.',
      input: v.object({ name: text('The procedure name shown in context.', 100) }),
      /** The catalog and view share names, so duplicates never select an arbitrary procedure. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { skills } = yield* client.ListSkillSummaries()
            const entries = inventory(skills, (item) => views.modelText(item.name))
            const found = yield* Effect.fromResult(named(entries, data.name))
            const response = yield* client.ReadSkill({ id: found.id })
            return { output: views.skill(response.skill, data.name.trim()) }
          }),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'save_skill',
      description:
        'Save a reusable procedure when the person asks. Include decisions and approval needs; saving it does not create a Routine.',
      input: v.object({
        name: text('A short procedure name.', 80),
        useWhen: text('When to use this procedure, in one sentence.', 300),
        instructions: text(
          'Steps, decisions, expected result and approval needs in Markdown.',
          20_000,
        ),
        forCompany,
      }),
      /** Refresh catalog naming after storage so the returned name can be used by read_skill. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.SaveSkill(data)
            const { skills } = yield* client.ListSkillSummaries()
            const entry = inventory(skills, (item) => views.modelText(item.name)).find(
              ({ item }) => item.id === response.skill.id,
            )
            if (entry === undefined) return yield* Effect.fail(new NameMissing({ name: data.name }))
            return { output: views.skillSummary(response.skill, entry.name) }
          }),
          { signal },
        )
      },
    }),
  ] as const
}
