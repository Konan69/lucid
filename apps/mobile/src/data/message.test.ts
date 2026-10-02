import type { FlueConversationMessage } from '@flue/sdk'
import {
  ApprovalId,
  InputRequestId,
  PersonId,
  RunId,
  RunOrigin,
  RunState,
  ServiceId,
  ThreadId,
  type Run,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Card,
  cardOf,
  isShown,
  momentOf,
  Speaker,
  speakerOf,
  stepsOf,
  stepsSummary,
  textOf,
  toolsOf,
  type Around,
  type ToolPart,
} from './message.ts'

const ada = { id: PersonId.make('ada'), name: 'Ada Obi', image: null }
const dami = { id: PersonId.make('dami'), name: 'Dami Cole', image: null }

/** A Run Dami started, which is what the server records when Dami's message reaches Vivid. */
const damisRun: Run = {
  id: RunId.make('submission-7'),
  threadId: ThreadId.make('thread'),
  turn: 7,
  origin: RunOrigin.cases.Message.make({ person: dami }),
  state: RunState.cases.Completed.make({ finishedAt: 2 }),
  startedAt: 1,
}

/** A Run Ada started, the turn after Dami's. */
const adasRun: Run = {
  id: RunId.make('submission-8'),
  threadId: ThreadId.make('thread'),
  turn: 8,
  origin: RunOrigin.cases.Message.make({ person: ada }),
  state: RunState.cases.Completed.make({ finishedAt: 4 }),
  startedAt: 3,
}

const shared: Around = { me: ada.id, shared: true, runs: [damisRun, adasRun] }
const alone: Around = { me: ada.id, shared: false, runs: [damisRun] }

const message = (
  changes: Partial<FlueConversationMessage> & Pick<FlueConversationMessage, 'role'>,
): FlueConversationMessage => ({
  id: 'message',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text: 'Hello', state: 'done' }],
  ...changes,
})

/** A Person's message in a shared Thread, as the server delivers it into Flue. */
const said = (attributes: Record<string, string>) =>
  message({
    role: 'system',
    display: 'hidden',
    signal: { tagName: 'message', attributes },
  })

const tool = (toolName: string, output: ToolPart['output']): ToolPart => ({
  type: 'dynamic-tool',
  toolName,
  toolCallId: `call-${toolName}`,
  state: 'output-available',
  input: {},
  output,
})

describe('who a message is from', () => {
  it('is the Person holding the phone in a private Thread', () => {
    expect(speakerOf(message({ role: 'user' }), alone)).toEqual(Speaker.Me())
  })

  it('is whoever the Run behind that turn says, on a shared Thread’s message', () => {
    expect(speakerOf(said({ turn: '7', from: 'Dami Cole' }), shared)).toEqual(
      Speaker.Member({ name: Option.some('Dami Cole') }),
    )
    expect(speakerOf(said({ turn: '8', from: 'Ada Obi' }), shared)).toEqual(Speaker.Me())
  })

  it('draws a message that came without a name without one, rather than making one up', () => {
    expect(speakerOf(said({ turn: '7' }), shared)).toEqual(Speaker.Member({ name: Option.none() }))
  })

  it('says who Vivid is answering only where more than one Person could have asked', () => {
    const reply = message({ role: 'assistant', purpose: 'assistant', submissionId: 'submission-7' })
    expect(speakerOf(reply, shared)).toEqual(Speaker.Vivid({ answering: Option.some('Dami Cole') }))
    expect(speakerOf(reply, alone)).toEqual(Speaker.Vivid({ answering: Option.none() }))
  })

  it('does not guess who Vivid is answering when no Run carried the reply', () => {
    const reply = message({ role: 'assistant', purpose: 'assistant', submissionId: 'unknown' })
    expect(speakerOf(reply, shared)).toEqual(Speaker.Vivid({ answering: Option.none() }))
  })

  it('reads a Routine or a follow-up as the reason Vivid spoke', () => {
    const due = message({
      role: 'system',
      signal: { tagName: 'schedule', attributes: { name: 'Morning brief' } },
    })
    const chase = message({ role: 'system', signal: { tagName: 'follow-up' } })
    expect(speakerOf(due, shared)).toEqual(
      Speaker.Wake({ reason: 'routine', name: Option.some('Morning brief') }),
    )
    expect(speakerOf(chase, shared)).toEqual(
      Speaker.Wake({ reason: 'follow-up', name: Option.none() }),
    )
  })

  it('leaves a decision and an answer to their cards', () => {
    expect(speakerOf(message({ role: 'system', signal: { tagName: 'approval' } }), shared)).toEqual(
      Speaker.Silent(),
    )
    expect(speakerOf(message({ role: 'system', signal: { tagName: 'answer' } }), shared)).toEqual(
      Speaker.Silent(),
    )
  })

  it('reads a runtime notice as nobody’s, and says when the reply failed', () => {
    expect(speakerOf(message({ role: 'system' }), shared)).toEqual(
      Speaker.Notice({ failed: false }),
    )
    expect(
      speakerOf(message({ role: 'system', settlement: { outcome: 'failed' } }), shared),
    ).toEqual(Speaker.Notice({ failed: true }))
  })
})

describe('what a message holds', () => {
  it('shows a shared Thread’s message although Flue hides signals', () => {
    expect(isShown(said({ turn: '7', from: 'Dami Cole' }))).toBe(true)
    expect(isShown(message({ role: 'system', display: 'hidden' }))).toBe(false)
    expect(isShown(message({ role: 'assistant' }))).toBe(true)
  })

  it('joins its text parts as paragraphs and keeps its tool calls apart', () => {
    const reply = message({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'First.', state: 'done' },
        tool('search_library', { results: [] }),
        { type: 'text', text: 'Second.', state: 'done' },
      ],
    })
    expect(textOf(reply)).toBe('First.\n\nSecond.')
    expect(toolsOf(reply).map((part) => part.toolName)).toEqual(['search_library'])
  })

  it('takes its time from when it finished, else when it started, else has none', () => {
    expect(
      momentOf(message({ role: 'assistant', metadata: { startedAt: 1, finishedAt: 2 } })),
    ).toEqual(Option.some(2))
    expect(momentOf(message({ role: 'assistant', metadata: { startedAt: 1 } }))).toEqual(
      Option.some(1),
    )
    expect(momentOf(message({ role: 'assistant' }))).toEqual(Option.none())
  })
})

describe('what Vivid did', () => {
  const running: ToolPart = {
    type: 'dynamic-tool',
    toolName: 'search_library',
    toolCallId: 'call-1',
    state: 'input-available',
    input: {},
  }

  it('names each step in the product’s words and says how it stands', () => {
    const steps = stepsOf([running, tool('create_task', {})])
    expect(steps.map((step) => [step.label, step.standing])).toEqual([
      ['Searching the Library', 'running'],
      ['Started tracking a task', 'done'],
    ])
  })

  it('collapses to one line that says whether it is still going', () => {
    expect(stepsSummary(stepsOf([running]), true)).toBe('Working')
    expect(stepsSummary(stepsOf([tool('create_task', {})]), false)).toBe('Did one thing')
    expect(stepsSummary(stepsOf([tool('a', {}), tool('b', {})]), false)).toBe('Did 2 things')
  })
})

describe('the card a tool result asks for', () => {
  it('is an Approval, by the id the Thread’s detail carries', () => {
    expect(
      cardOf(
        tool('use_tool', {
          kind: 'approval-request',
          approvalId: 'approval-1',
          summary: 'Send it',
        }),
      ),
    ).toEqual(Option.some(Card.Approval({ id: ApprovalId.make('approval-1') })))
  })

  it('is an Input request', () => {
    expect(
      cardOf(tool('ask', { kind: 'input-request', requestId: 'request-1', question: 'Which?' })),
    ).toEqual(Option.some(Card.Input({ id: InputRequestId.make('request-1') })))
  })

  it('is a Connection request, carrying what it shows', () => {
    const request = {
      kind: 'connection-request' as const,
      service: ServiceId.make('gmail'),
      serviceName: 'Gmail',
      reason: 'To send the note',
      ready: false,
    }
    expect(cardOf(tool('connect', request))).toEqual(Option.some(Card.Connection({ request })))
  })

  it('is a tracked Task, waiting on someone only when it is not the asker’s own', () => {
    expect(
      cardOf(tool('create_task', { task: { title: 'Sign the lease', assignee: 'Dami' } })),
    ).toEqual(
      Option.some(Card.Tracked({ title: 'Sign the lease', waitingOn: Option.some('Dami') })),
    )
    expect(
      cardOf(tool('create_task', { task: { title: 'Sign the lease', assignee: 'you' } })),
    ).toEqual(Option.some(Card.Tracked({ title: 'Sign the lease', waitingOn: Option.none() })))
  })

  it('is nothing for an ordinary result or a call that has not finished', () => {
    expect(cardOf(tool('search_library', { results: [] }))).toEqual(Option.none())
    expect(
      cardOf({
        type: 'dynamic-tool',
        toolName: 'use_tool',
        toolCallId: 'call',
        state: 'input-available',
        input: {},
      }),
    ).toEqual(Option.none())
  })
})
