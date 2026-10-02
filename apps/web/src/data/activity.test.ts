import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { describeToolCall, readAnswered, readAsked } from './activity'

describe('a step, in words', () => {
  it('describes a completed Library search with its query and result count', () => {
    expect(
      describeToolCall(
        'search_library',
        readAsked({ query: 'pricing' }),
        readAnswered({ results: [{}, {}] }),
        'done',
      ),
    ).toEqual({ label: 'Searched the Library', detail: '“pricing” · 2 sources' })
  })

  it('preserves failure wording for an otherwise completed task update', () => {
    expect(
      describeToolCall(
        'update_task',
        Option.none(),
        readAnswered({ task: { title: 'Review PRD', status: 'done' } }),
        'failed',
      ),
    ).toEqual({ label: 'Could not update the task', detail: 'Review PRD' })
  })

  it('says a Task was marked done, and names it from what Vivid asked when nothing came back', () => {
    expect(
      describeToolCall(
        'update_task',
        readAsked({ task: 'Signed NDA from Dami' }),
        readAnswered({ task: { status: 'done' } }),
        'done',
      ),
    ).toEqual({ label: 'Marked a task done', detail: 'Signed NDA from Dami' })
  })

  it('says which account a connection was used through and what for', () => {
    expect(
      describeToolCall(
        'use_tool',
        readAsked({ account: 'Gmail (Work)', tool: 'send_email', summary: 'Send Dami the NDA' }),
        readAnswered({ ok: true }),
        'done',
      ),
    ).toEqual({ label: 'Used an integration', detail: 'Gmail (Work) · Send Dami the NDA' })
  })

  it('says what work on the Computer was for, while it is still running', () => {
    expect(
      describeToolCall(
        'run_command',
        readAsked({ command: 'ls', summary: 'List the downloads' }),
        Option.none(),
        'running',
      ),
    ).toEqual({ label: 'Working on its computer', detail: 'List the downloads' })
  })

  it('gives a tool it has not heard of a true line and nothing made up', () => {
    expect(
      describeToolCall('future_tool', readAsked({ anything: 1 }), Option.none(), 'running'),
    ).toEqual({ label: 'Working' })
    expect(
      describeToolCall('future_tool', Option.none(), readAnswered('not an object'), 'done'),
    ).toEqual({ label: 'Did something' })
  })
})
