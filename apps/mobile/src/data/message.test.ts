import type { FlueConversationMessage } from '@flue/sdk'
import {
  ApprovalId,
  ConnectionAuthorization,
  ConnectionId,
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
  currentStepOf,
  isShown,
  momentOf,
  picturesOf,
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

  it('keeps named, unnamed and repeated image parts in order, including inline previews', () => {
    const pictures = picturesOf(
      message({
        role: 'user',
        parts: [
          { type: 'text', text: 'Have a look at this.', state: 'done' },
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'https://example.com/picture',
            filename: 'Picture.png',
          },
          { type: 'file', mediaType: 'application/pdf', url: 'https://example.com/document' },
          { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,/9j/4A==' },
          { type: 'file', mediaType: 'image/png', url: 'https://example.com/picture' },
          { type: 'file', mediaType: 'image/png' },
        ],
      }),
    )
    expect(pictures).toEqual([
      { key: 'message:1', url: 'https://example.com/picture', name: Option.some('Picture.png') },
      { key: 'message:3', url: 'data:image/jpeg;base64,/9j/4A==', name: Option.none() },
      { key: 'message:4', url: 'https://example.com/picture', name: Option.none() },
    ])
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
    const steps = stepsOf([running, tool('remember', {})])
    expect(steps.map((step) => [step.label, step.standing])).toEqual([
      ['Searching the Library', 'running'],
      ['Remembered', 'done'],
    ])
  })

  it('collapses to one line: what it is doing while it works, what it did once it has', () => {
    const steps = stepsOf([tool('remember', {}), running])
    expect(stepsSummary(steps, true)).toBe('Searching the Library…')
    expect(Option.map(currentStepOf(steps, true), (step) => step.id)).toEqual(Option.some('call-1'))
    expect(stepsSummary(stepsOf([tool('remember', {})]), false)).toBe('Remembered')
  })

  it('does not call a step in progress once the reply has ended', () => {
    // A call left running in a reply that is over was abandoned; nothing is happening now.
    const steps = stepsOf([running, tool('create_task', {})])
    expect(currentStepOf(steps, false)).toEqual(Option.none())
    expect(stepsSummary(steps, false)).toBe('Searching the Library and 1 more step')
  })

  it('keeps show calls out of steps even when their input cannot be drawn', () => {
    expect(stepsOf([tool('show', {}), running])).toEqual(stepsOf([running]))
    expect(stepsOf([tool('show', {})])).toEqual([])
  })

  it('offers Watch only for the current computer step while the reply is working', () => {
    const computer = ['bash', 'browse', 'use_desktop'].map((toolName): ToolPart => ({
      type: 'dynamic-tool',
      toolName,
      toolCallId: `call-${toolName}`,
      state: 'input-available',
      input: {},
    }))
    for (const call of computer) {
      const steps = stepsOf([call])
      expect(Option.exists(currentStepOf(steps, true), (step) => step.onComputer)).toBe(true)
      expect(Option.exists(currentStepOf(steps, false), (step) => step.onComputer)).toBe(false)
      expect(
        Option.exists(currentStepOf(stepsOf([call, running]), true), (step) => step.onComputer),
      ).toBe(false)
    }
    expect(currentStepOf(stepsOf([tool('browse', {})]), true)).toEqual(Option.none())
    expect(
      currentStepOf(
        stepsOf([
          {
            type: 'dynamic-tool',
            toolName: 'bash',
            toolCallId: 'failed',
            state: 'output-error',
            input: {},
            errorText: 'Stopped',
          },
        ]),
        true,
      ),
    ).toEqual(Option.none())
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
    expect(cardOf(tool('connect', request))).toEqual(
      Option.some(Card.Connection({ request, authorization: Option.none() })),
    )
  })

  it('carries what finishing it takes when Vivid has already begun adding the Integration', () => {
    const request = {
      kind: 'connection-request' as const,
      service: ServiceId.make('linear'),
      serviceName: 'Linear',
      reason: 'To read the issue',
      ready: false as const,
    }
    const authorization = ConnectionAuthorization.cases.EnterKey.make({
      connectionId: ConnectionId.make('started'),
      fields: [{ name: 'api_key', label: 'API key' }],
    })
    expect(cardOf(tool('add_integration', { ...request, authorization }))).toEqual(
      Option.some(Card.Connection({ request, authorization: Option.some(authorization) })),
    )
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
