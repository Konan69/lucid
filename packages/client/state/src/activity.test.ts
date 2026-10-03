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
    ).toMatchObject({ label: 'Searched the Library', detail: '“pricing” · 2 sources' })
  })

  it('reads a tool that answered it could not do it as a failed step', () => {
    // The call returned, so the conversation marks it done; the tool's own answer says otherwise.
    expect(
      describeToolCall('remember', readAsked({}), readAnswered({ ok: false }), 'done'),
    ).toEqual({ state: 'failed', label: 'Could not remember that' })
    expect(
      describeToolCall('remember', readAsked({}), readAnswered({ ok: true }), 'done').state,
    ).toBe('done')
  })

  it('preserves failure wording for an otherwise completed task update', () => {
    expect(
      describeToolCall(
        'update_task',
        Option.none(),
        readAnswered({ task: { title: 'Review PRD', status: 'done' } }),
        'failed',
      ),
    ).toMatchObject({ label: 'Could not update the task', detail: 'Review PRD' })
  })

  it('says a Task was marked done, and names it from what Vivid asked when nothing came back', () => {
    expect(
      describeToolCall(
        'update_task',
        readAsked({ task: 'Signed NDA from Dami' }),
        readAnswered({ task: { status: 'done' } }),
        'done',
      ),
    ).toMatchObject({ label: 'Marked a task done', detail: 'Signed NDA from Dami' })
  })

  it('says which account a connection was used through and what for', () => {
    expect(
      describeToolCall(
        'use_tool',
        readAsked({ account: 'Gmail (Work)', tool: 'send_email', summary: 'Send Dami the NDA' }),
        readAnswered({ ok: true }),
        'done',
      ),
    ).toMatchObject({ label: 'Used an integration', detail: 'Gmail (Work) · Send Dami the NDA' })
  })

  it('says what work on the Computer was for, while it is still running', () => {
    expect(
      describeToolCall(
        'run_command',
        readAsked({ command: 'ls', summary: 'List the downloads' }),
        Option.none(),
        'running',
      ),
    ).toMatchObject({ label: 'Working on its computer', detail: 'List the downloads' })
  })

  it('gives a tool it has not heard of a true line and nothing made up', () => {
    expect(
      describeToolCall('future_tool', readAsked({ anything: 1 }), Option.none(), 'running'),
    ).toMatchObject({ label: 'Working' })
    expect(
      describeToolCall('future_tool', Option.none(), readAnswered('not an object'), 'done'),
    ).toMatchObject({ label: 'Did something' })
  })
})

describe('document steps', () => {
  it('names writing, revising and failed writes from actual receipts', () => {
    for (const [output, called, label, state] of [
      [{ ok: true, created: true }, 'done', 'Wrote a document', 'done'],
      [{ ok: true, created: false }, 'done', 'Revised a document', 'done'],
      [{ ok: false, created: false }, 'done', 'Could not write the document', 'failed'],
      [{ ok: true, created: false }, 'failed', 'Could not write the document', 'failed'],
      [{}, 'running', 'Writing a document', 'running'],
    ] as const) {
      expect(
        describeToolCall(
          'write_document',
          readAsked({ title: 'Launch plan' }),
          readAnswered(output),
          called,
        ),
      ).toEqual({ state, label, detail: 'Launch plan' })
    }
  })
  it('names reading and missing documents with their requested title', () => {
    expect(
      describeToolCall(
        'read_document',
        readAsked({ title: 'Launch plan' }),
        readAnswered({ ok: true }),
        'done',
      ),
    ).toEqual({ state: 'done', label: 'Read a document', detail: 'Launch plan' })
    expect(
      describeToolCall(
        'read_document',
        readAsked({ title: 'Missing' }),
        readAnswered({ ok: false }),
        'done',
      ),
    ).toEqual({ state: 'failed', label: 'Could not read the document', detail: 'Missing' })
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
