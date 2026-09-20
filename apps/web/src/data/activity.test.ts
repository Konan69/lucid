import type { FlueConversationMessage } from '@flue/react'
import { describe, expect, it } from 'vitest'
import { activityForMessage, describeToolCall } from './activity'

/** Supplies the required Flue envelope so each test can focus on the timeline behavior. */
function message(
  value: Partial<FlueConversationMessage> &
    Pick<FlueConversationMessage, 'id' | 'role' | 'purpose' | 'parts'>,
): FlueConversationMessage {
  return { display: 'visible', ...value }
}

describe('describeToolCall', () => {
  it('describes a completed Library search with its query and result count', () => {
    expect(
      describeToolCall(
        'search_library',
        { query: 'pricing' },
        { results: [{}, {}] },
        'done',
      ),
    ).toEqual({ label: 'Searched the Library', detail: '“pricing” · 2 sources' })
  })

  it('preserves failure wording for an otherwise completed task update', () => {
    expect(
      describeToolCall('update_task', null, { task: { title: 'Review PRD', status: 'done' } }, 'failed'),
    ).toEqual({ label: 'Could not update the task', detail: 'Review PRD' })
  })

  it('uses the generic state label for an unknown runtime tool', () => {
    expect(describeToolCall('future_tool', null, null, 'running')).toEqual({ label: 'Working' })
  })
})

describe('activityForMessage', () => {
  it('projects a user message as one timestamped request', () => {
    const activity = activityForMessage(
      message({
        id: 'message-1',
        role: 'user',
        purpose: 'user',
        parts: [{ type: 'text', text: '  Review\nthis  ', state: 'done' }],
        metadata: { startedAt: 1_000 },
      }),
    )

    expect(activity).toEqual([
      {
        id: 'message-1',
        label: 'Request submitted',
        detail: 'Review this',
        timestamp: 1_000,
        type: 'request',
      },
    ])
  })

  it('orders tool activity before the assistant response summary', () => {
    const activity = activityForMessage(
      message({
        id: 'message-2',
        role: 'assistant',
        purpose: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'list_tasks',
            toolCallId: 'tool-1',
            state: 'output-available',
            input: {},
            output: { tasks: [{}, {}] },
          },
          { type: 'text', text: 'Two tasks remain.', state: 'done' },
        ],
        metadata: {
          startedAt: 1_000,
          finishedAt: 2_500,
          model: 'openrouter/example/model',
          usage: { totalTokens: 300 },
        },
      }),
    )

    expect(activity).toEqual([
      {
        id: 'message-2:tool-1',
        label: 'Checked the task list',
        detail: '2 open',
        failed: false,
        timestamp: 2_500,
        type: 'tool',
      },
      {
        id: 'message-2',
        label: 'Response completed',
        detail: 'example/model · 1.5s · 300 tokens',
        failed: false,
        timestamp: 2_500,
        type: 'response',
      },
    ])
  })

  it('uses a dispatch signal timestamp for a triggered routine', () => {
    const activity = activityForMessage(
      message({
        id: 'message-3',
        role: 'system',
        purpose: 'dispatch',
        display: 'hidden',
        signal: { attributes: { scheduledAt: '2025-01-02T03:04:05.000Z' } },
        parts: [{ type: 'text', text: 'Morning review', state: 'done' }],
      }),
    )

    expect(activity).toEqual([
      {
        id: 'message-3',
        label: 'Routine triggered',
        detail: 'Morning review',
        timestamp: Date.parse('2025-01-02T03:04:05.000Z'),
        type: 'request',
      },
    ])
  })
})
