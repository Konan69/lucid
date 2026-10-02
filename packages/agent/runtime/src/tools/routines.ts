import { defineTool } from '@flue/runtime'
import { RoutineTrigger } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** Routines belong to the acting Person; cron and timezone are supplied explicitly. */
export function routineTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'create_routine',
      description: 'Create a Routine when the person asks for recurring work on a schedule.',
      input: v.object({
        name: text('A short name for the recurring work.', 200),
        prompt: text('What Vivid should do each time.', 4000),
        cron: text('The cron schedule.', 200),
        timezone: text('The IANA timezone for this schedule.', 200),
      }),
      /** Storage references and past receipts never enter the model result. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.CreateRoutine({
              name: data.name,
              prompt: data.prompt,
              trigger: RoutineTrigger.cases.Schedule.make({
                cron: data.cron,
                timezone: data.timezone,
              }),
            })
            return { output: views.routine(response.routine, response.routine.name) }
          }),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'list_routines',
      description: 'List the person’s Routines and their schedules.',
      input: v.object({}),
      /** Routine metadata is projected explicitly instead of returning RPC envelopes. */
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.ListRoutines()
            return { output: { routines: views.routines(response.routines) } }
          }),
          { signal },
        )
      },
    }),
  ] as const
}
