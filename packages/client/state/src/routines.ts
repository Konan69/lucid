import {
  RoutineTrigger,
  type Occurrence,
  type Routine,
  type RoutineId,
  type RoutineListResponse,
} from '@vivid/contracts'
import { Equal, Option } from 'effect'

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

/**
 * What a Person has changed in the editor of an existing Routine and not saved yet. Each part is
 * absent until they touch it.
 *
 * The editor used to copy the Routine once, when it opened. A Routine is live: when someone else
 * renamed it meanwhile, the copy made every untouched field look edited, and Save wrote the old
 * values back over theirs. Holding only the Person's own changes lets everything they have not
 * touched keep following the server.
 */
export interface RoutineEdits {
  readonly name: Option.Option<string>
  readonly prompt: Option.Option<string>
  /** The trigger is edited as one thing: its kind and the schedule written for it. */
  readonly trigger: Option.Option<Pick<RoutineFields, 'kind' | 'cron' | 'timezone'>>
}

/** An editor nobody has typed in. */
export const noEdits: RoutineEdits = {
  name: Option.none(),
  prompt: Option.none(),
  trigger: Option.none(),
}

/** What the editor shows: the Routine as the server has it now, with the unsaved edits on top. */
export const editing = (routine: Routine, edits: RoutineEdits): RoutineFields => {
  const saved = fieldsOf(routine)
  const trigger = Option.getOrElse(edits.trigger, () => saved)
  return {
    name: Option.getOrElse(edits.name, () => saved.name),
    prompt: Option.getOrElse(edits.prompt, () => saved.prompt),
    kind: trigger.kind,
    cron: trigger.cron,
    timezone: trigger.timezone,
  }
}

/** Which of the editor's values are the Person's own: the ones that differ from the Routine. */
export const editsIn = (routine: Routine, fields: RoutineFields): RoutineEdits => {
  const saved = fieldsOf(routine)
  const sameTrigger =
    fields.kind === saved.kind &&
    fields.cron === saved.cron &&
    Equal.equals(fields.timezone, saved.timezone)
  return {
    name: fields.name === saved.name ? Option.none() : Option.some(fields.name),
    prompt: fields.prompt === saved.prompt ? Option.none() : Option.some(fields.prompt),
    trigger: sameTrigger
      ? Option.none()
      : Option.some({ kind: fields.kind, cron: fields.cron, timezone: fields.timezone }),
  }
}

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
