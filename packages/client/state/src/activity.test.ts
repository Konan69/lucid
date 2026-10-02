import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { describeToolCall, readAnswered, readAsked, summarizeSteps } from './activity.js'

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

describe('the line a reply’s steps collapse to', () => {
  const steps = [
    { id: 'a', label: 'Searched the Library' },
    { id: 'b', label: 'Using its browser' },
    { id: 'c', label: 'Started tracking a task' },
  ]

  it('says what Vivid is doing right now while it is on a step', () => {
    expect(summarizeSteps(steps, Option.some('b'))).toBe('Using its browser…')
  })

  it('says what was done, with a count of the rest, once nothing is in progress', () => {
    expect(summarizeSteps(steps.slice(0, 1), Option.none())).toBe('Searched the Library')
    expect(summarizeSteps(steps.slice(0, 2), Option.none())).toBe(
      'Searched the Library and one more thing',
    )
    expect(summarizeSteps(steps, Option.none())).toBe('Searched the Library and 2 more things')
  })

  it('falls back to what was done when the step it was told about is not among them', () => {
    expect(summarizeSteps(steps.slice(0, 1), Option.some('gone'))).toBe('Searched the Library')
  })
})
