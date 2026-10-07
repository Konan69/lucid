import { Cron } from 'croner'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { RoutineTrigger } from '@vivid/contracts'

export class InvalidRoutineSchedule extends Schema.TaggedError<InvalidRoutineSchedule>()(
  'InvalidRoutineSchedule',
  { message: Schema.String },
  { title: 'Invalid Routine schedule' },
) {}

export class RoutineTimePassed extends Schema.TaggedError<RoutineTimePassed>()(
  'RoutineTimePassed',
  { at: Schema.Finite },
  { title: 'One-off Routine must be in the future' },
) {}

/** Reject expired one-offs before any write; disabling a consumed Routine remains valid. */
export const requireFuture = Effect.fn('RoutineSchedule.requireFuture')(function* (
  trigger: RoutineTrigger,
  now: number,
) {
  if (RoutineTrigger.guards.Once(trigger) && trigger.at <= now)
    return yield* new RoutineTimePassed({ at: trigger.at })
})

/** Reject nonexistent or ambiguous local times rather than silently moving a reminder at DST. */
export const resolveLocal = Effect.fn('RoutineSchedule.resolveLocal')(function* (
  localAt: string,
  timezone: string,
) {
  const zoned = DateTime.makeZoned(`${localAt}:00Z`, {
    timeZone: timezone,
    adjustForTimeZone: true,
    disambiguation: 'reject',
  })
  if (Option.isNone(zoned) || DateTime.formatIsoOffset(zoned.value).slice(0, 16) !== localAt)
    return yield* new InvalidRoutineSchedule({
      message: 'Choose a valid, unambiguous local date and time',
    })
  return RoutineTrigger.cases.Once.make({ at: DateTime.toEpochMillis(zoned.value), timezone })
})

/** Parses without installing timers; both cron syntax and the IANA timezone must be valid. */
const probe = Effect.fn('RoutineSchedule.probe')(function* (
  trigger: typeof RoutineTrigger.cases.Schedule.Type,
) {
  return yield* Effect.try({
    try: () => {
      new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format()
      return new Cron(trigger.cron, { paused: true, timezone: trigger.timezone })
    },
    catch: () => new InvalidRoutineSchedule({ message: 'Routine schedule or timezone is invalid' }),
  })
})

/** Webhooks have no due timestamp; schedules are computed against the Effect clock's instant. */
export const nextExpectedAt = Effect.fn('RoutineSchedule.nextExpectedAt')(function* (
  trigger: RoutineTrigger,
  enabled: boolean,
  now: number,
) {
  if (RoutineTrigger.guards.Once(trigger)) {
    yield* Effect.try({
      try: () =>
        new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format(trigger.at),
      catch: () =>
        new InvalidRoutineSchedule({ message: 'One-off Routine instant or timezone is invalid' }),
    })
    return enabled ? trigger.at : null
  }
  if (!RoutineTrigger.guards.Schedule(trigger)) return null
  const cron = yield* probe(trigger)
  const next = cron.nextRun(new Date(now))
  cron.stop()
  return enabled && next !== null ? next.getTime() : null
})
