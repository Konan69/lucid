import { defineTool } from '@flue/runtime'
import { RoutineTrigger } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** This paragraph is also model-visible in create_routine's description, without an agent edit. */
export const instructions =
  'A reminder or anything to do once at a time is a one-off Routine. Use a Once trigger with a local date-time in the Person’s time zone; never supply epoch numbers or identifiers. Work on a clock schedule is a Schedule trigger. Reacting when something happens in an Integration is never a Routine: watch it with find_events and watch. Background work follows the same approval rules as work asked for in a Thread.'

const triggerInput = v.variant('kind', [
  v.object({
    kind: v.literal('Once'),
    localAt: text('Local date and time in the Person’s time zone, YYYY-MM-DDTHH:mm.', 16),
  }),
  v.object({
    kind: v.literal('Schedule'),
    cron: text('The cron schedule.', 200),
    timezone: text('The IANA timezone.', 200),
  }),
])
// Integration events wake Vivid through Watches (`watches.ts`), not through Routines.

/** Routines belong to the acting Person: a reminder at a time, or work on a schedule. */
export function routineTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'create_routine',
      description: `Create a Routine for one-off or recurring work. ${instructions}`,
      input: v.object({
        summary,
        name: text('A short name for the work.', 200),
        prompt: text('What Vivid should do when it runs.', 4000),
        trigger: triggerInput,
      }),
      /** Storage references and past receipts never enter the model result. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response =
              data.trigger.kind === 'Once'
                ? yield* client.CreateOnceRoutine({
                    name: data.name,
                    prompt: data.prompt,
                    localAt: data.trigger.localAt,
                  })
                : yield* client.CreateRoutine({
                    name: data.name,
                    prompt: data.prompt,
                    trigger: RoutineTrigger.cases.Schedule.make({
                      cron: data.trigger.cron,
                      timezone: data.trigger.timezone,
                    }),
                  })
            return { output: views.routine(response.routine, response.routine.name) }
          }),
          { signal, tool: 'create_routine' },
        )
      },
    }),
    defineTool({
      name: 'list_routines',
      description: 'List the Person’s Routines and what starts them.',
      input: v.object({ summary }),
      /** Routine metadata is projected explicitly instead of returning RPC envelopes. */
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.ListRoutines()
            return { output: { routines: views.routines(response.routines) } }
          }),
          { signal, tool: 'list_routines' },
        )
      },
    }),
  ] as const
}
