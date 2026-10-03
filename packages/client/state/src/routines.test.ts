import { RoutineId, RoutineTrigger, type Routine } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import * as routines from './routines.js'

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
      routines.describeTrigger(
        RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1', timezone: 'UTC' }),
      ),
    ).toBe('Mondays at 9:00 AM · UTC')
    expect(
      routines.describeTrigger(
        RoutineTrigger.cases.Schedule.make({ cron: '*/5 * * * *', timezone: 'UTC' }),
      ),
    ).toBe('Cron */5 * * * * · UTC')
    expect(routines.describeTrigger(RoutineTrigger.cases.Webhook.make({}))).toBe(
      'When something calls it',
    )
  })

  it('describes and preserves a one-off when its metadata changes', () => {
    const trigger = RoutineTrigger.cases.Once.make({
      at: Date.UTC(2026, 9, 4, 8),
      timezone: 'Africa/Lagos',
    })
    const current = routine('Reminder', { trigger })
    expect(routines.describeTrigger(trigger)).toBe('Once, on 4 Oct 2026 at 09:00')
    const fields = routines.fieldsOf(current)
    expect(routines.triggerOf(fields, 'UTC')).toEqual(trigger)
    expect(routines.fieldsDiffer(current, fields, 'UTC')).toBe(false)
    expect(routines.fieldsComplete(fields, 'UTC')).toBe(true)
    const typed = { ...fields, name: 'Check the report' }
    const edits = routines.editsIn(current, typed)
    expect(routines.triggerOf(routines.editing(current, edits), 'UTC')).toEqual(trigger)
    expect(routines.unsaved(edits, typed)).toEqual(routines.noEdits)
  })

  it("starts a new schedule in the Person's own zone until they write another", () => {
    const fields = routines.emptyFields()
    expect(routines.triggerOf(fields, 'Africa/Lagos')).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1-5', timezone: 'Africa/Lagos' }),
    )
    expect(
      routines.triggerOf({ ...fields, timezone: Option.some('Europe/London') }, 'Africa/Lagos'),
    ).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * 1-5', timezone: 'Europe/London' }),
    )
  })

  it('keeps the written schedule when the trigger is switched to a webhook and back', () => {
    const scheduled = { ...routines.fieldsOf(routine('a', {})), cron: '0 6 * * *' }
    const asWebhook = { ...scheduled, kind: 'Webhook' as const }
    expect(routines.triggerOf(asWebhook, 'UTC')).toEqual(RoutineTrigger.cases.Webhook.make({}))
    expect(routines.triggerOf({ ...asWebhook, kind: 'Schedule' }, 'UTC')).toEqual(
      RoutineTrigger.cases.Schedule.make({ cron: '0 6 * * *', timezone: 'Africa/Lagos' }),
    )
  })

  it('reads an untouched Routine as unchanged and a new trigger as an edit', () => {
    const current = routine('a', {})
    const fields = routines.fieldsOf(current)
    expect(routines.fieldsDiffer(current, fields, 'UTC')).toBe(false)
    expect(routines.fieldsDiffer(current, { ...fields, kind: 'Webhook' }, 'UTC')).toBe(true)
    expect(routines.fieldsDiffer(current, { ...fields, name: ' a ' }, 'UTC')).toBe(false)
  })

  it('keeps following the Routine in every field the Person has not touched', () => {
    const opened = routine('brief', {})
    const typed = { ...routines.editing(opened, routines.noEdits), name: 'Morning brief' }
    const edits = routines.editsIn(opened, typed)

    // Someone else rewrites the instruction while the editor is open.
    const moved = routine('brief', { prompt: 'Write the brief, shorter.' })
    const shown = routines.editing(moved, edits)
    expect(shown.name).toBe('Morning brief')
    expect(shown.prompt).toBe('Write the brief, shorter.')
    // Only the name is this Person's edit; the instruction is not written back over theirs.
    expect(routines.editsIn(moved, shown)).toEqual({ ...routines.noEdits, name: edits.name })
  })

  it('drops an edit once the Routine itself says the same', () => {
    const opened = routine('brief', {})
    const typed = { ...routines.editing(opened, routines.noEdits), name: 'Morning brief' }
    const saved = routine('brief', { name: 'Morning brief' })
    expect(routines.editsIn(saved, typed)).toEqual(routines.noEdits)
  })

  it('keeps what was typed while a save was on its way', () => {
    const opened = routine('brief', {})
    const submitted = { ...routines.editing(opened, routines.noEdits), name: 'Morning brief' }
    // The save for the name is still out when the instruction is changed too.
    const typedSince = { ...submitted, prompt: 'Write the brief, shorter.' }
    const edits = routines.editsIn(opened, typedSince)
    expect(routines.unsaved(edits, submitted)).toEqual({
      ...routines.noEdits,
      prompt: Option.some('Write the brief, shorter.'),
    })
  })

  it('cannot be saved without a name, an instruction and a whole schedule', () => {
    const fields = { ...routines.emptyFields(), name: 'Brief', prompt: 'Write it.' }
    expect(routines.fieldsComplete(fields, 'UTC')).toBe(true)
    expect(routines.fieldsComplete({ ...fields, prompt: '  ' }, 'UTC')).toBe(false)
    expect(routines.fieldsComplete({ ...fields, cron: ' ' }, 'UTC')).toBe(false)
    expect(routines.fieldsComplete({ ...fields, kind: 'Webhook', cron: '' }, 'UTC')).toBe(true)
  })
})

describe('expectations', () => {
  const list = { routines: [routine('a', {}), routine('b', {})] }

  it('pauses one Routine without guessing when it next runs', () => {
    const next = routines.enabledSet(RoutineId.make('a'), false)(list)
    expect(next.routines.map((item) => [item.id, item.enabled, item.nextRunAt])).toEqual([
      ['a', false, NOW],
      ['b', true, NOW],
    ])
  })

  it('shows a saved edit on the Routine it was made to', () => {
    const trigger = RoutineTrigger.cases.Webhook.make({})
    const next = routines.edited(RoutineId.make('b'), {
      name: 'Intake',
      prompt: 'File it.',
      trigger,
    })(list)
    expect(next.routines.map((item) => [item.name, item.trigger._tag])).toEqual([
      ['a', 'Schedule'],
      ['Intake', 'Webhook'],
    ])
  })

  it('removes a deleted Routine', () => {
    expect(
      routines
        .removed(RoutineId.make('a'))(list)
        .routines.map((item) => item.id),
    ).toEqual(['b'])
  })

  it('adds a Routine the server just returned once, however the two answers are ordered', () => {
    const created = routine('c', {})
    const once = routines.confirmed(created)(list)
    expect(once.routines.map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(routines.confirmed(created)(once)).toBe(once)
  })
})
