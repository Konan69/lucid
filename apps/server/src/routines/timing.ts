import { Cron } from 'croner'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { RoutineTrigger } from '@vivid/contracts'

export class InvalidRoutineSchedule extends Schema.TaggedError<InvalidRoutineSchedule>()(
  'InvalidRoutineSchedule',
  { message: Schema.String },
  { title: 'Invalid Routine schedule' },
) {}

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
  if (!RoutineTrigger.guards.Schedule(trigger)) return null
  const cron = yield* probe(trigger)
  const next = cron.nextRun(new Date(now))
  cron.stop()
  return enabled && next !== null ? next.getTime() : null
})
