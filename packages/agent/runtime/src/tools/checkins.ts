import { Effect } from 'effect'
import {
  Tool,
  CheckinFocus,
  CheckinTiming,
  CheckinNotFound,
  OpenWork,
  WatchIntent,
  WatchPurpose,
  type Watch,
} from '@vivid/contracts'
import * as v from 'valibot'
import { defineTool } from './tool.ts'
import { named } from './names.ts'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'
import { modelText } from './views.ts'

const focus = v.variant('kind', [
  v.object({ kind: v.literal('OpenWork') }),
  v.object({
    kind: v.literal('Owed'),
    name: text('The exact name returned by list_open_work.', 400),
  }),
  v.object({ kind: v.literal('Thread') }),
])
const timing = v.variant('kind', [
  v.object({
    kind: v.literal('Chosen'),
    nextAt: v.pipe(
      v.number(),
      v.finite(),
      v.description(
        'The next chosen instant, in epoch milliseconds. Use the response clock, the real deadline, or the timer Integration clock; never guess the current time.',
      ),
    ),
    why: text('Why this is the right time to revisit the open work.', 1000),
  }),
  v.object({
    kind: v.literal('Requested'),
    request: text('The Person’s exact timing or recurrence request.', 1000),
    timezone: text('Their known IANA time zone.', 200),
  }),
])
/** Event intent carries no check-in fields; a check-in names an explicit source and timing choice. */
export const purpose = v.variant('kind', [
  v.object({ kind: v.literal('Event') }),
  v.object({ kind: v.literal('Checkin'), focus, timing }),
])

const timingOf = (input: v.InferOutput<typeof timing>) =>
  input.kind === 'Chosen'
    ? CheckinTiming.cases.Chosen.make({ nextAt: input.nextAt, why: input.why })
    : CheckinTiming.cases.Requested.make({ request: input.request, timezone: input.timezone })

/** Resolve source names within this Person's open records; Thread means the current source Thread. */
const focusOf = Effect.fn('CheckinTools.focus')(function* (input: v.InferOutput<typeof focus>) {
  const { client, acting } = yield* Scope
  switch (input.kind) {
    case 'OpenWork':
      return CheckinFocus.cases.OpenWork.make({})
    case 'Thread':
      return CheckinFocus.cases.Thread.make({ threadId: acting.threadId })
    case 'Owed': {
      const { work } = yield* client.ListOpenWork()
      const owed = work.filter(OpenWork.guards.Owed)
      const selected = yield* Effect.fromResult(
        named(
          owed.map((item) => ({ name: `${item.what} from ${item.from}`, item })),
          input.name,
        ),
      )
      return CheckinFocus.cases.Owed.make({ owedId: selected.owedId })
    }
  }
})

/** Arming authority stays on the server; the model chooses only the intent. */
export const intent = Effect.fn('CheckinTools.intent')(function* (
  input: v.InferOutput<typeof purpose>,
) {
  if (input.kind === 'Event') return WatchIntent.cases.Event.make({})
  return WatchIntent.cases.Checkin.make({
    focus: yield* focusOf(input.focus),
    timing: timingOf(input.timing),
  })
})

/** Open-work selection and time changes use the same Watch metadata as creation. */
export function checkinTools(
  runTool: RunTool,
  view: (watch: Watch) => Record<string, import('effect').Schema.Json>,
) {
  return [
    defineTool({
      name: Tool.list_open_work,
      description:
        'List explicit open work and its existing check-ins. If an open record has no check-in, choose its next check in this Run and set a timer through make-an-integration, find_events, watch with Checkin purpose, then use_tool with its persisted operationKey. It is set only after the timer confirms. Do not infer obligations from unread Threads or transcripts.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { work } = yield* client.ListOpenWork()
            return {
              output: {
                work: work.map((source) =>
                  OpenWork.match(source, {
                    Owed: ({ what, from, nextStep, due, checkins }) => ({
                      kind: 'owed',
                      name: `${modelText(what)} from ${modelText(from)}`,
                      what: modelText(what),
                      from: modelText(from),
                      nextStep: modelText(nextStep),
                      due,
                      checkins,
                    }),
                    Project: ({ nextStep, checkins }) => ({
                      kind: 'project',
                      nextStep: modelText(nextStep),
                      checkins,
                    }),
                  }),
                ),
              },
            }
          }),
          { signal, tool: 'list_open_work' },
        )
      },
    }),
    defineTool({
      name: Tool.update_checkin,
      description:
        'Change when a named check-in next runs, keeping its source. Call this after a still-open chosen check to select its next time, or to change the Person’s timing request. It becomes Awaiting again. Arm the timer Integration with the returned operationKey and read its actual receipt before saying it is scheduled.',
      input: v.object({ summary, name: text('The exact check-in Watch name.', 200), timing }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client, acting } = yield* Scope
            const found = (yield* client.ListWatches()).watches.find(
              (watch) => watch.name === data.name,
            )
            if (found === undefined || !WatchPurpose.guards.Checkin(found.purpose))
              return yield* new CheckinNotFound({
                personId: acting.personId,
                name: data.name,
                message: 'There is no check-in by that name.',
              })
            return {
              output: view(
                (yield* client.UpdateCheckin({
                  name: data.name,
                  focus: found.purpose.focus,
                  timing: timingOf(data.timing),
                })).watch,
              ),
            }
          }),
          { signal, tool: 'update_checkin' },
        )
      },
    }),
  ] as const
}
