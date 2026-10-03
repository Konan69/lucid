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

/**
 * How a Routine starts, as a sentence, when Vivid set that up in conversation and the editor does
 * not change it: watching an Integration, or firing once at a time. None when the start is one a
 * Person sets in the editor (a schedule or a webhook). An editor that drew its schedule controls
 * for these would show a time the Routine does not run at.
 */
export const fixedStart = (fields: RoutineFields): Option.Option<string> =>
  Option.orElse(
    Option.map(fields.watching, (watching) => `When ${watching.event} in ${watching.account}.`),
    () =>
      Option.map(
        fields.once,
        (once) => `${describeTrigger(RoutineTrigger.cases.Once.make(once))}.`,
      ),
  )

/** When a Routine runs, in one phrase. */
export const describeTrigger = (trigger: RoutineTrigger): string =>
  RoutineTrigger.match(trigger, {
    Once: ({ at, timezone }) => {
      const date = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        dateStyle: 'medium',
      }).format(at)
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        timeStyle: 'short',
      }).format(at)
      return `Once, on ${date} at ${time}`
    },
    Schedule: ({ cron, timezone }) => `${describeCron(cron)} · ${timezone}`,
    Webhook: () => 'When something calls it',
    Integration: ({ account, event }) => `When ${event} in ${account}`,
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
  /**
   * What the Routine is watching for, when it starts on something happening in an Integration.
   * Vivid sets that up in conversation, where it can find the account and the event; the editor
   * shows it and does not change it. While it is present it is what starts the Routine, and the
   * kind and schedule above are not.
   */
  readonly watching: Option.Option<Watching>
  /** Conversation-created one-offs retain their instant while metadata is edited. */
  readonly once: Option.Option<OneOff>
}

/** An Integration trigger as it is: the account, what happens there, and which of it counts. */
export type Watching = Omit<typeof RoutineTrigger.cases.Integration.Type, '_tag'>

/** One-off timing remains intact until the editor explicitly supports editing it. */
export type OneOff = Omit<typeof RoutineTrigger.cases.Once.Type, '_tag'>

/** The editor's starting values for a new Routine. */
export const emptyFields = (): RoutineFields => ({
  name: '',
  prompt: '',
  kind: 'Schedule',
  cron: DEFAULT_CRON,
  timezone: Option.none(),
  watching: Option.none(),
  once: Option.none(),
})

/** The editor's starting values for a Routine that already exists. */
export const fieldsOf = (routine: Routine): RoutineFields =>
  RoutineTrigger.match(routine.trigger, {
    Once: ({ at, timezone }): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Schedule',
      cron: DEFAULT_CRON,
      timezone: Option.some(timezone),
      watching: Option.none(),
      once: Option.some({ at, timezone }),
    }),
    Schedule: ({ cron, timezone }): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Schedule',
      cron,
      timezone: Option.some(timezone),
      watching: Option.none(),
      once: Option.none(),
    }),
    Webhook: (): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Webhook',
      cron: DEFAULT_CRON,
      timezone: Option.none(),
      watching: Option.none(),
      once: Option.none(),
    }),
    Integration: ({ account, event, filter }): RoutineFields => ({
      name: routine.name,
      prompt: routine.prompt,
      kind: 'Schedule',
      cron: DEFAULT_CRON,
      timezone: Option.none(),
      watching: Option.some({ account, event, filter }),
      once: Option.none(),
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
    watching: saved.watching,
    once: saved.once,
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

/**
 * The edits still unsaved after a save was accepted. Only what was actually submitted is settled:
 * the editor stays open and usable while a save is on its way, and words typed in that moment
 * were not part of it. Clearing every edit on acknowledgment threw those words away.
 */
export const unsaved = (edits: RoutineEdits, submitted: RoutineFields): RoutineEdits => ({
  name: Option.filter(edits.name, (name) => name !== submitted.name),
  prompt: Option.filter(edits.prompt, (prompt) => prompt !== submitted.prompt),
  trigger: Option.filter(
    edits.trigger,
    (trigger) =>
      trigger.kind !== submitted.kind ||
      trigger.cron !== submitted.cron ||
      !Equal.equals(trigger.timezone, submitted.timezone),
  ),
})

/** The trigger the editor describes. `zone` is the Person's own, used until they write another. */
export const triggerOf = (fields: RoutineFields, zone: string): RoutineTrigger =>
  Option.match(fields.once, {
    onSome: (once) => RoutineTrigger.cases.Once.make(once),
    onNone: () =>
      Option.match(fields.watching, {
        onSome: (watching) => RoutineTrigger.cases.Integration.make(watching),
        onNone: () =>
          fields.kind === 'Webhook'
            ? RoutineTrigger.cases.Webhook.make({})
            : RoutineTrigger.cases.Schedule.make({
                cron: fields.cron.trim(),
                timezone: Option.getOrElse(fields.timezone, () => zone).trim(),
              }),
      }),
  })

/** Whether two triggers start a Routine the same way. */
const sameTrigger = (left: RoutineTrigger, right: RoutineTrigger): boolean =>
  RoutineTrigger.match(left, {
    Once: ({ at, timezone }) =>
      RoutineTrigger.guards.Once(right) && right.at === at && right.timezone === timezone,
    Webhook: () => RoutineTrigger.guards.Webhook(right),
    Schedule: ({ cron, timezone }) =>
      RoutineTrigger.guards.Schedule(right) && right.cron === cron && right.timezone === timezone,
    Integration: ({ account, event, filter }) =>
      RoutineTrigger.guards.Integration(right) &&
      right.account === account &&
      right.event === event &&
      Equal.equals(right.filter, filter),
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
    Once: ({ at, timezone }) => Number.isFinite(at) && timezone !== '',
    Webhook: () => true,
    Schedule: ({ cron, timezone }) => cron !== '' && timezone !== '',
    Integration: () => true,
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
    templates: current.templates,
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
    templates: current.templates,
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
      : { routines: [routine, ...current.routines], templates: current.templates }
