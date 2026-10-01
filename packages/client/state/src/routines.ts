import {
  RoutineTrigger,
  type Occurrence,
  type Routine,
  type RoutineId,
  type RoutineListResponse,
} from '@vivid/contracts'
import { Option } from 'effect'

/**
 * Routines, as pure functions over what the server sends.
 *
 * The screen reads `live.routines`; this module decides how a Routine is described, what the
 * editor holds while a Person is changing one, and what the list will look like once a change has
 * been accepted. Nothing here talks to the server.
 */

export type RoutineList = typeof RoutineListResponse.Type
export type { Occurrence, Routine }

/** The two ways a Routine starts, in the order the editor offers them. */
export const TRIGGER_KINDS = ['Schedule', 'Webhook'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

/** The schedules a Person can pick by name. Anything else is written as a cron expression. */
export const SCHEDULE_PRESETS = [
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 9 * * *', label: 'Every day at 9:00 AM' },
  { cron: '0 9 * * 1-5', label: 'Weekdays at 9:00 AM' },
  { cron: '0 9 * * 1', label: 'Mondays at 9:00 AM' },
] as const

const DEFAULT_CRON = '0 9 * * 1-5'

/** A cron expression in words when it is one of the presets, and as itself when it is not. */
export const describeCron = (cron: string): string => {
  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.cron === cron)
  return preset === undefined ? `Cron ${cron}` : preset.label
}

/** When a Routine runs, in one phrase. */
export const describeTrigger = (trigger: RoutineTrigger): string =>
  RoutineTrigger.match(trigger, {
    Schedule: ({ cron, timezone }) => `${describeCron(cron)} · ${timezone}`,
    Webhook: () => 'When something calls it',
  })

/** The Occurrence that started last. The server sends them newest first. */
export const latestOccurrence = (routine: Routine): Option.Option<Occurrence> =>
  Option.fromUndefinedOr(routine.runs[0])

/**
 * What the editor holds for one Routine.
 *
 * The trigger is kept as its kind plus the schedule's own fields, so switching to "when something
 * calls it" and back does not lose the schedule the Person had written. The time zone is absent
 * until the Person writes one: until then the form shows their own zone, which can still be
 * arriving from Settings when the form opens.
 */
export interface RoutineFields {
  readonly name: string
  readonly prompt: string
  readonly kind: TriggerKind
  readonly cron: string
  readonly timezone: Option.Option<string>
}

/** The editor's starting values for a new Routine. */
export const emptyFields = (): RoutineFields => ({
  name: '',
  prompt: '',
  kind: 'Schedule',
  cron: DEFAULT_CRON,
  timezone: Option.none(),
})

/** The editor's starting values for a Routine that already exists. */
export const fieldsOf = (routine: Routine): RoutineFields =>
  RoutineTrigger.match(routine.trigger, {
    Schedule: ({ cron, timezone }): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Schedule',
      cron,
      timezone: Option.some(timezone),
    }),
    Webhook: (): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Webhook',
      cron: DEFAULT_CRON,
      timezone: Option.none(),
    }),
  })

/** The trigger the editor describes. `zone` is the Person's own, used until they write another. */
export const triggerOf = (fields: RoutineFields, zone: string): RoutineTrigger =>
  fields.kind === 'Webhook'
    ? RoutineTrigger.cases.Webhook.make({})
    : RoutineTrigger.cases.Schedule.make({
        cron: fields.cron.trim(),
        timezone: Option.getOrElse(fields.timezone, () => zone).trim(),
      })

/** Whether two triggers start a Routine the same way. */
const sameTrigger = (left: RoutineTrigger, right: RoutineTrigger): boolean =>
  RoutineTrigger.match(left, {
    Webhook: () => RoutineTrigger.guards.Webhook(right),
    Schedule: ({ cron, timezone }) =>
      RoutineTrigger.guards.Schedule(right) && right.cron === cron && right.timezone === timezone,
  })

/** Whether the editor holds something the Routine does not. */
export const fieldsDiffer = (routine: Routine, fields: RoutineFields, zone: string): boolean =>
  fields.name.trim() !== routine.name ||
  fields.prompt.trim() !== routine.prompt ||
  !sameTrigger(routine.trigger, triggerOf(fields, zone))

/** Whether the editor holds enough to save: a name, an instruction and a complete trigger. */
export const fieldsComplete = (fields: RoutineFields, zone: string): boolean =>
  fields.name.trim() !== '' &&
  fields.prompt.trim() !== '' &&
  RoutineTrigger.match(triggerOf(fields, zone), {
    Webhook: () => true,
    Schedule: ({ cron, timezone }) => cron !== '' && timezone !== '',
  })

// ── Expectations: the result the server is expected to send next ───────────

/**
 * A copy of a Routine with some fields replaced. A Routine is a plain decoded record, so copying
 * its own fields is a complete copy; the fields are named by the caller, never guessed.
 */
const revised = (routine: Routine, changes: Partial<Routine>): Routine =>
  Object.assign({}, routine, changes)

/** Applies one change to the Routine with this id and leaves every other Routine as it is. */
const onRoutine =
  (id: RoutineId, edit: (routine: Routine) => Routine) =>
  (current: RoutineList): RoutineList => ({
    routines: current.routines.map((routine) => (routine.id === id ? edit(routine) : routine)),
  })

/** A Routine paused or resumed. When it next runs is the server's to say, so that is left alone. */
export const enabledSet = (id: RoutineId, enabled: boolean) =>
  onRoutine(id, (routine) => revised(routine, { enabled }))

/** A Routine after its editor was saved. */
export const edited = (
  id: RoutineId,
  changes: { readonly name: string; readonly prompt: string; readonly trigger: RoutineTrigger },
) => onRoutine(id, (routine) => revised(routine, changes))

/** A deleted Routine, gone with its history. */
export const removed =
  (id: RoutineId) =>
  (current: RoutineList): RoutineList => ({
    routines: current.routines.filter((routine) => routine.id !== id),
  })

/**
 * A Routine the server has just returned from a call, in the list even if the live query's next
 * result has not arrived yet. It adds nothing when that result got there first.
 */
export const confirmed =
  (routine: Routine) =>
  (current: RoutineList): RoutineList =>
    current.routines.some((candidate) => candidate.id === routine.id)
      ? current
      : { routines: [routine, ...current.routines] }
