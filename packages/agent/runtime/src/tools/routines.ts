import { defineTool } from '@flue/runtime'
import { InvalidRequest, RoutineTrigger } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** This paragraph is also model-visible in create_routine's description, without an agent edit. */
export const instructions =
  'A reminder or anything to do once at a time is a one-off Routine. Use a Once trigger with a local date-time in the Person’s time zone; never supply epoch numbers or identifiers. When a Person describes a recurring reaction, offer “when this happens, I’ll do that”. Use find_events with the Integration’s account name to discover what can be watched, then create_routine with that account, the event description and its filter. Explain the actual delivery cadence and stop if the Integration cannot support the event. Background work follows the same approval rules as work asked for in a Thread.'

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
  v.object({
    kind: v.literal('Integration'),
    account: text('The account name the Person was shown, such as Gmail (Work).', 300),
    event: text('The event name or plain description returned by find_events.', 1000),
    filter: v.pipe(v.unknown(), v.description('JSON configuration following find_events.')),
  }),
])
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** The model supplies names and provider data; server authority resolves the private Connection. */
const triggerOf = Effect.fn('RoutineTools.triggerOf')(function* (
  input: Exclude<v.InferOutput<typeof triggerInput>, { kind: 'Once' }>,
) {
  if (input.kind === 'Schedule')
    return RoutineTrigger.cases.Schedule.make({ cron: input.cron, timezone: input.timezone })
  const filter = yield* decodeJson(input.filter).pipe(
    Effect.mapError(() => new InvalidRequest({ message: 'The event filter must be JSON.' })),
  )
  return RoutineTrigger.cases.Integration.make({
    account: input.account,
    event: input.event,
    filter,
  })
})

/** Routines belong to the acting Person, whether a schedule or Integration starts them. */
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
                    trigger: yield* triggerOf(data.trigger),
                  })
            return { output: views.routine(response.routine, response.routine.name) }
          }),
          { signal, tool: 'create_routine' },
        )
      },
    }),
    defineTool({
      name: 'find_events',
      description: 'Find what can happen in an Integration to start a Routine, in words.',
      input: v.object({
        summary,
        account: text('The exact account name the Person was shown.', 300),
      }),
      /** Discovery returns names and provider filter schemas without storage authority. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return { output: yield* client.FindEvents({ account: data.account }) }
          }),
          { signal, tool: 'find_events' },
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
