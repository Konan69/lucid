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

  it('says what each Watch and Feed step did, with the account, Watch or card it was about', () => {
    const step = (tool: string, asked: object, answered: object) =>
      describeToolCall(tool, readAsked(asked), readAnswered(answered), 'done')
    expect(step('find_events', { account: 'Gmail (Work)' }, { events: [] })).toMatchObject({
      label: 'Looked at what can be watched',
      detail: 'Gmail (Work)',
    })
    expect(step('watch', { name: 'New mail in Work Gmail' }, {})).toMatchObject({
      label: 'Started a watch',
      detail: 'New mail in Work Gmail',
    })
    expect(step('list_watches', {}, { watches: [{}, {}] })).toMatchObject({
      label: 'Checked what is watched',
      detail: '2 watches',
    })
    expect(step('stop_watching', { name: 'New mail in Work Gmail' }, {})).toMatchObject({
      label: 'Stopped a watch',
      detail: 'New mail in Work Gmail',
    })
    expect(step('post', { title: 'Your flight moved' }, { ok: true })).toMatchObject({
      label: 'Put it on your Feed',
      detail: 'Your flight moved',
    })
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

  it('says which account a connection was used through and what for', () => {
    expect(
      describeToolCall(
        'use_tool',
        readAsked({ account: 'Gmail (Work)', tool: 'send_email', summary: 'Send Dami the NDA' }),
        readAnswered({ ok: true }),
        'done',
      ),
    ).toMatchObject({ label: 'Used Gmail (Work)', detail: 'Send Dami the NDA' })
  })

  it('says what work on the Computer was for, while it is still running', () => {
    expect(
      describeToolCall('bash', readAsked({ command: 'ls ~/Downloads' }), Option.none(), 'running'),
    ).toMatchObject({ label: 'Working on its computer', detail: 'ls ~/Downloads' })
  })

  it('says work in the Person’s own apps is on their computer, not Vivid’s', () => {
    const asked = readAsked({ summary: 'Open the March invoice in Excel' })
    const use = 'use_person_computer'
    expect(describeToolCall(use, asked, Option.none(), 'running')).toMatchObject({
      state: 'running',
      label: 'Working on your computer',
      detail: 'Open the March invoice in Excel',
    })
    expect(describeToolCall(use, asked, readAnswered({ ok: true }), 'done')).toMatchObject({
      label: 'Worked on your computer',
    })
    expect(describeToolCall(use, asked, readAnswered({ ok: false }), 'done')).toMatchObject({
      state: 'failed',
      label: 'Your computer did not do it',
    })
  })

  it('gives a tool it has not heard of a true line and nothing made up', () => {
    expect(
      describeToolCall('future_tool', readAsked({ anything: 1 }), Option.none(), 'running'),
    ).toMatchObject({ label: 'Working' })
    expect(
      describeToolCall('future_tool', Option.none(), readAnswered('not an object'), 'done'),
    ).toMatchObject({ label: 'Did something' })
  })

  it('says a built-in way of working like a saved one, and never by its runtime name', () => {
    expect(
      describeToolCall(
        'activate_skill',
        readAsked({ name: 'first-conversation' }),
        readAnswered('loaded'),
        'done',
      ),
    ).toEqual({ state: 'done', label: 'Read how it does this' })
  })

  it('leads every step with what Vivid said it was for', () => {
    expect(
      describeToolCall(
        'search_library',
        readAsked({ query: 'pricing', summary: 'The price we quoted Dami' }),
        readAnswered({ results: [{}] }),
        'done',
      ),
    ).toEqual({
      state: 'done',
      label: 'Searched the Library',
      detail: 'The price we quoted Dami · “pricing” · 1 source',
    })
  })

  it('says a purpose once, and makes it the line of a tool it has no words for', () => {
    // The Computer's steps already carry the purpose as their detail.
    expect(
      describeToolCall('use_tool', readAsked({ summary: 'Send the NDA' }), Option.none(), 'running')
        .detail,
    ).toBe('Send the NDA')
    expect(
      describeToolCall(
        'future_tool',
        readAsked({ summary: 'Friday’s plan' }),
        readAnswered({ ok: true }),
        'done',
      ),
    ).toEqual({ state: 'done', label: 'Friday’s plan' })
    // A step that failed keeps the plain failure line, with the purpose beside it.
    expect(
      describeToolCall(
        'future_tool',
        readAsked({ summary: 'Friday’s plan' }),
        readAnswered({ ok: false }),
        'done',
      ),
    ).toEqual({ state: 'failed', label: 'Something did not work', detail: 'Friday’s plan' })
  })
})

describe('document steps', () => {
  it('names writing, revising and failed writes from actual receipts', () => {
    for (const [output, called, label, state] of [
      [{ ok: true, created: true, changed: true }, 'done', 'Wrote a document', 'done'],
      [{ ok: true, created: false, changed: true }, 'done', 'Revised a document', 'done'],
      [{ ok: false, created: false }, 'done', 'Could not write the document', 'failed'],
      [
        { ok: true, created: false, changed: true },
        'failed',
        'Could not write the document',
        'failed',
      ],
      [{ ok: true, created: false, changed: false }, 'done', 'Document unchanged', 'done'],
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
    { id: 'c', label: 'Started a project' },
  ]

  it('says what Vivid is doing right now while it is on a step', () => {
    expect(summarizeSteps(steps, Option.some('b'))).toBe('Using its browser…')
  })

  it('says what was done, with a count of the rest, once nothing is in progress', () => {
    expect(summarizeSteps(steps.slice(0, 1), Option.none())).toBe('Searched the Library')
    expect(summarizeSteps(steps.slice(0, 2), Option.none())).toBe(
      'Searched the Library and 1 more step',
    )
    expect(summarizeSteps(steps, Option.none())).toBe('Searched the Library and 2 more steps')
  })

  it('falls back to what was done when the step it was told about is not among them', () => {
    expect(summarizeSteps(steps.slice(0, 1), Option.some('gone'))).toBe('Searched the Library')
  })
})
