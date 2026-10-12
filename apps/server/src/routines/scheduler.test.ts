import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { LibraryFolderId, PersonId, Routine, RoutineId, RoutineTrigger } from '@vivid/contracts'
import { bodyOf, deliveryAttributes } from './scheduler.ts'
import type { RoutineRecord } from './records.ts'

const folder = LibraryFolderId.make('28665fc4-bc14-40e2-8055-ab38994407d5')

/** The scheduler's two delivery variants carry authority separately from readable work instructions. */
function record(libraryFolderId: LibraryFolderId | null): RoutineRecord {
  return {
    personId: PersonId.make('person'),
    companyId: null,
    webhookKeyHash: null,
    integration: null,
    watchRevision: 0,
    routine: Routine.make({
      id: RoutineId.make('routine'),
      name: 'Morning review',
      prompt: 'Review sources.',
      trigger: RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * *', timezone: 'Africa/Lagos' }),
      libraryFolderId,
      enabled: true,
      nextExpectedAt: 0,
      lastMissedAt: null,
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: 0,
      runs: [],
    }),
  }
}

describe('Routine delivery folder', () => {
  it('scopes scheduled and webhook work without placing the folder reference in the body', () => {
    const routine = record(folder)
    for (const payload of [Option.none<string>(), Option.some('Incoming event')]) {
      const body = bodyOf(routine, payload)
      expect(body).not.toContain(folder)
      expect(body).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu)
      expect(deliveryAttributes(routine)).toEqual({
        name: 'Morning review',
      })
    }
    expect(bodyOf(routine, Option.some('Incoming event'))).toContain('Payload:\nIncoming event')
  })
  it('keeps unscoped Routine deliveries genuinely absent', () => {
    const routine = record(null)
    expect(bodyOf(routine, Option.none())).toBe('Review sources.')
    expect(deliveryAttributes(routine)).toEqual({ name: 'Morning review' })
  })
})
