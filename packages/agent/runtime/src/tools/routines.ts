import { defineTool } from '@flue/runtime'
import { RoutineTrigger } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { text } from './inputs.ts'
import { settle } from './result.ts'

/** Routines belong to the acting Person; cron and timezone are always supplied explicitly. */
export function routineTools(acting: Option.Option<Acting>) {
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
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .CreateRoutine({
                  name: data.name,
                  prompt: data.prompt,
                  trigger: RoutineTrigger.cases.Schedule.make({
                    cron: data.cron,
                    timezone: data.timezone,
                  }),
                })
                .pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'list_routines',
      description: 'List the person’s Routines and their schedules.',
      input: v.object({}),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.ListRoutines().pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
