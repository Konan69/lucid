import { Effect } from 'effect'
import {
  Tool,
  CheckinFocus,
  CheckinTiming,
  OwedState,
  ProjectWork,
  ReviseWatchRequest,
  WatchIntent,
  WatchPurpose,
  type Owed,
  type Project,
  type Watch,
} from '@vivid/contracts'
import * as v from 'valibot'
import { defineTool } from './tool.ts'
import { named } from './names.ts'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'
import { modelText } from './views.ts'
import { view } from './watches.ts'
import { projectNamed } from './projects.ts'

const focus = v.variant('kind', [
  v.object({ kind: v.literal('OpenWork') }),
  v.object({
    kind: v.literal('Owed'),
    name: text('The exact name returned by list_open_work.', 400),
  }),
  v.object({ kind: v.literal('Thread') }),
  v.object({ kind: v.literal('Project'), name: text('The exact active Project name.', 80) }),
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

/** What the Person is still waiting on: the owed records that are open, read fresh. */
const openOwed = Effect.fn('CheckinTools.openOwed')(function* () {
  const { client } = yield* Scope
  const { owed } = yield* client.ListOwed()
  return owed.filter((record) => OwedState.isAnyOf(['Open', 'Nudged'])(record.state))
})

/**
 * The check-ins that cover one owed record: one on that record, on its Thread, or a sweep of all
 * open work. Explicit records only, so the model never infers work from transcripts.
 */
const coveringOf = (record: Owed, watches: ReadonlyArray<Watch>) =>
  watches.flatMap((watch) => {
    if (!WatchPurpose.guards.Checkin(watch.purpose)) return []
    const covers = CheckinFocus.match(watch.purpose.focus, {
      OpenWork: () => true,
      Owed: ({ owedId }) => owedId === record.id,
      Thread: ({ threadId }) => threadId === record.threadId,
      Project: () => false,
    })
    return covers ? [modelText(watch.name)] : []
  })

/** Active Projects are named explicitly; only a check-in on that Project covers its next step. */
const projectWork = (projects: ReadonlyArray<Project>, watches: ReadonlyArray<Watch>) =>
  projects.flatMap((project) =>
    ProjectWork.guards.Active(project.work)
      ? [
          {
            kind: 'project',
            name: modelText(project.name),
            objective: modelText(project.work.objective),
            nextStep: modelText(project.work.nextStep),
            checkins: watches.flatMap((watch) =>
              WatchPurpose.guards.Checkin(watch.purpose) &&
              CheckinFocus.guards.Project(watch.purpose.focus) &&
              watch.purpose.focus.projectId === project.id
                ? [modelText(watch.name)]
                : [],
            ),
          },
        ]
      : [],
  )

/** Resolve source names within this Person's open records; Thread means the current source Thread. */
const focusOf = Effect.fn('CheckinTools.focus')(function* (input: v.InferOutput<typeof focus>) {
  const { acting } = yield* Scope
  switch (input.kind) {
    case 'OpenWork':
      return CheckinFocus.cases.OpenWork.make({})
    case 'Thread':
      return CheckinFocus.cases.Thread.make({ threadId: acting.threadId })
    case 'Project': {
      const project = yield* projectNamed(input.name)
      return CheckinFocus.cases.Project.make({ projectId: project.id })
    }
    case 'Owed': {
      const open = yield* openOwed()
      const selected = yield* Effect.fromResult(
        named(
          open.map((item) => ({ name: `${item.what} from ${item.from}`, item })),
          input.name,
        ),
      )
      return CheckinFocus.cases.Owed.make({ owedId: selected.id })
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
export function checkinTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.list_open_work,
      description:
        'List explicit open work, including active Projects with their goals and next steps, and its existing check-ins. If an open record has no check-in, choose its next check in this Run and set a timer through make-an-integration, find_events, watch with Checkin purpose, then use_tool with its persisted operationKey. It is set only after the timer confirms. Do not infer obligations from unread Threads or transcripts.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const open = yield* openOwed()
            const { watches } = yield* client.ListWatches()
            const { projects } = yield* client.ListProjects()
            return {
              output: {
                work: [
                  ...open.map((record) => ({
                    kind: 'owed',
                    name: `${modelText(record.what)} from ${modelText(record.from)}`,
                    what: modelText(record.what),
                    from: modelText(record.from),
                    nextStep: modelText(record.nextStep),
                    due: record.due,
                    checkins: coveringOf(record, watches),
                  })),
                  ...projectWork(projects, watches),
                ],
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
            const { client } = yield* Scope
            // The server keeps what the check-in follows and answers CheckinNotFound for a name
            // that is not a live check-in.
            const response = yield* client.ReviseWatch(
              ReviseWatchRequest.cases.Timing.make({
                name: data.name,
                timing: timingOf(data.timing),
              }),
            )
            return { output: view(response.watch) }
          }),
          { signal, tool: 'update_checkin' },
        )
      },
    }),
  ] as const
}
