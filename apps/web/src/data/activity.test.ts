import { describe, expect, it } from 'vitest'
import { describeToolCall } from './activity'

describe('describeToolCall', () => {
  it('describes a completed Library search with its query and result count', () => {
    expect(
      describeToolCall('search_library', { query: 'pricing' }, { results: [{}, {}] }, 'done'),
    ).toEqual({ label: 'Searched the Library', detail: '“pricing” · 2 sources' })
  })

  it('preserves failure wording for an otherwise completed task update', () => {
    expect(
      describeToolCall(
        'update_task',
        null,
        { task: { title: 'Review PRD', status: 'done' } },
        'failed',
      ),
    ).toEqual({ label: 'Could not update the task', detail: 'Review PRD' })
  })

  it('uses the generic state label for an unknown runtime tool', () => {
    expect(describeToolCall('future_tool', null, null, 'running')).toEqual({ label: 'Working' })
  })
})
