import { RoutineId, RoutineTrigger, type Routine } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  confirmed,
  describeTrigger,
  edited,
  emptyFields,
  enabledSet,
  fieldsComplete,
  fieldsDiffer,
  fieldsOf,
  removed,
  triggerOf,
} from './routines'

const NOW = Date.UTC(2026, 9, 1, 12)

/** A weekday-morning Routine, changed per test to the one thing the test is about. */
const routine = (id: string, changes: Partial<Routine>): Routine => ({
  id: RoutineId.make(id),
  name: id,
  prompt: 'Write the brief.',
  trigger: RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1-5', timezone: 'Africa/Lagos' }),
  libraryFolderId: null,
  enabled: true,
  nextExpectedAt: NOW,
  lastMissedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  nextRunAt: NOW,
  runs: [],
  ...changes,
})

describe('the editor', () => {
  it('describes a named schedule in words and any other as its expression', () => {
    expect(
      describeTrigger(RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1', timezone: 'UTC' })),
    ).toBe('Mondays at 9:00 AM · UTC')
    expect(
      describeTrigger(RoutineTrigger.cases.Schedule.make({ cron: '*/5 * * * *', timezone: 'UTC' })),
    ).toBe('Cron */5 * * * * · UTC')
    expect(describeTrigger(RoutineTrigger.cases.Webhook.make({}))).toBe('When something calls it')
  })

  it("starts a new schedule in the Person's own zone until they write another", () => {
    const fields = emptyFields()
    expect(triggerOf(fields, 'Africa/Lagos')).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1-5', timezone: 'Africa/Lagos' }),
    )
    expect(
      triggerOf({ ...fields, timezone: Option.some('Europe/London') }, 'Africa/Lagos'),
    ).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1-5', timezone: 'Europe/London' }),
    )
  })

  it('keeps the written schedule when the trigger is switched to a webhook and back', () => {
    const scheduled = { ...fieldsOf(routine('a', {})), cron: '0 6 * * *' }
    const asWebhook = { ...scheduled, kind: 'Webhook' as const }
    expect(triggerOf(asWebhook, 'UTC')).toEqual(RoutineTrigger.cases.Webhook.make({}))
    expect(triggerOf({ ...asWebhook, kind: 'Schedule' }, 'UTC')).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 6 * * *', timezone: 'Africa/Lagos' }),
    )
  })

  it('reads an untouched Routine as unchanged and a new trigger as an edit', () => {
    const current = routine('a', {})
    const fields = fieldsOf(current)
    expect(fieldsDiffer(current, fields, 'UTC')).toBe(false)
    expect(fieldsDiffer(current, { ...fields, kind: 'Webhook' }, 'UTC')).toBe(true)
    expect(fieldsDiffer(current, { ...fields, name: ' a ' }, 'UTC')).toBe(false)
  })

  it('cannot be saved without a name, an instruction and a whole schedule', () => {
    const fields = { ...emptyFields(), name: 'Brief', prompt: 'Write it.' }
    expect(fieldsComplete(fields, 'UTC')).toBe(true)
    expect(fieldsComplete({ ...fields, prompt: '  ' }, 'UTC')).toBe(false)
    expect(fieldsComplete({ ...fields, cron: ' ' }, 'UTC')).toBe(false)
    expect(fieldsComplete({ ...fields, kind: 'Webhook', cron: '' }, 'UTC')).toBe(true)
  })
})

describe('expectations', () => {
  const list = { routines: [routine('a', {}), routine('b', {})] }

  it('pauses one Routine without guessing when it next runs', () => {
    const next = enabledSet(RoutineId.make('a'), false)(list)
    expect(next.routines.map((item) => [item.id, item.enabled, item.nextRunAt])).toEqual([
      ['a', false, NOW],
      ['b', true, NOW],
    ])
  })

  it('shows a saved edit on the Routine it was made to', () => {
    const trigger = RoutineTrigger.cases.Webhook.make({})
    const next = edited(RoutineId.make('b'), { name: 'Intake', prompt: 'File it.', trigger })(list)
    expect(next.routines.map((item) => [item.name, item.trigger._tag])).toEqual([
      ['a', 'Schedule'],
      ['Intake', 'Webhook'],
    ])
  })

  it('removes a deleted Routine', () => {
    expect(removed(RoutineId.make('a'))(list).routines.map((item) => item.id)).toEqual(['b'])
  })

  it('adds a Routine the server just returned once, however the two answers are ordered', () => {
    const created = routine('c', {})
    const once = confirmed(created)(list)
    expect(once.routines.map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(confirmed(created)(once)).toBe(once)
  })
})
