import { DEFAULT_WAKING_HOURS, Tool } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { defineTool } from './tool.ts'
import { summary } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'

/** Spoken corrections change one bound without silently resetting the other. */
export function pacingTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.set_waking_hours,
      description:
        'Save the Person’s explicit hours for ordinary unasked notices. Use only when they state or change contact hours in words, never infer from their calendar. Supply start for “not before 11” (660), end for “quiet after 10pm” (1320), or both for a window. Times are minutes after local midnight in their saved time zone. Omitted bounds stay as saved, default 09:00–21:30. Urgent notices still go at once. Keep their expressed contact preferences in the attention page as prose too.',
      input: v.pipe(
        v.object({
          summary,
          start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439))),
          end: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440))),
        }),
        v.check(
          (hours) => hours.start !== undefined || hours.end !== undefined,
          'State a start or end.',
        ),
      ),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const settings = yield* client.GetSettings()
            const before =
              settings.wakingHours === null ? DEFAULT_WAKING_HOURS : settings.wakingHours
            const saved = yield* client.SetWakingHours({
              start: data.start === undefined ? before.start : data.start,
              end: data.end === undefined ? before.end : data.end,
            })
            return {
              output: { ok: true, wakingHours: saved.wakingHours, timezone: saved.timezone },
            }
          }),
          { signal, tool: 'set_waking_hours' },
        )
      },
    }),
  ]
}
