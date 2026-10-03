import { expect, it } from '@effect/vitest'
import { RoutineTrigger } from '@vivid/contracts'
import { Effect } from 'effect'
import { InvalidRoutineSchedule, resolveLocal } from './timing.ts'

it.effect('resolves wall-clock reminders in the Person’s zone', () =>
  Effect.gen(function* () {
    expect(yield* resolveLocal('2026-10-04T09:00', 'Africa/Lagos')).toEqual(
      RoutineTrigger.cases.Once.make({
        at: Date.UTC(2026, 9, 4, 8),
        timezone: 'Africa/Lagos',
      }),
    )
    expect(yield* resolveLocal('2026-07-04T09:00', 'Europe/London')).toMatchObject({
      at: Date.UTC(2026, 6, 4, 8),
    })
  }),
)

it.effect('refuses invalid dates and daylight-saving gaps or repeated wall-clock times', () =>
  Effect.gen(function* () {
    for (const localAt of ['2026-02-30T09:00', '2026-03-29T01:30', '2026-10-25T01:30']) {
      expect(yield* Effect.flip(resolveLocal(localAt, 'Europe/London'))).toBeInstanceOf(
        InvalidRoutineSchedule,
      )
    }
    expect(yield* Effect.flip(resolveLocal('2026-10-04T09:00', 'Invalid/Zone'))).toBeInstanceOf(
      InvalidRoutineSchedule,
    )
  }),
)
