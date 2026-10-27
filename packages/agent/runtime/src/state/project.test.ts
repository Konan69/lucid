import { applyImmutable, assertValidOp, diffRevisions } from '@earendil-works/chord/delta'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, EntryId, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { ConversationFrame, ConversationState } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { SIGNAL_ENTRY } from '../delivery.ts'
import { RESPONSE_ENTRY, RUN_ENTRY } from '../response.ts'
import { project, projector, type Projected, type Viewed } from './project.ts'

const isEntryId = (value: number): value is EntryId => Number.isSafeInteger(value)
const isConversationId = (value: number): value is ConversationId => Number.isSafeInteger(value)

/** A transcript entry as Pi would hand it over; ids are the test's own, in writing order. */
const entry = (
  id: number,
  kind: string,
  given: { readonly model?: Message; readonly data?: EntryRecord['data'] } = {},
): EntryRecord => {
  const conversationId = 1
  if (!isEntryId(id) || !isConversationId(conversationId)) return expect.fail('ids are integers')
  const base = { id, conversationId, kind }
  const modelled = given.model === undefined ? base : { ...base, model: [given.model] }
  return given.data === undefined ? modelled : { ...modelled, data: given.data }
}

const said = (id: number, text: string, at = 1_000 + id) =>
  entry(id, 'pi.user', { model: { role: 'user', content: text, timestamp: at } })

const signalled = (id: number, type: string, attributes: Record<string, string>, body: string) =>
  entry(id, SIGNAL_ENTRY, {
    model: { role: 'user', content: `<${type}>${body}</${type}>`, timestamp: 1_000 + id },
    data: { type, attributes, body },
  })

const answered = (id: number, message: ReturnType<typeof fauxAssistantMessage>) =>
  entry(id, 'pi.assistant', { model: message })

const resulted = (
  id: number,
  call: string,
  given: { readonly details?: JsonObject; readonly text?: string; readonly isError?: boolean },
) => {
  const base = {
    role: 'toolResult' as const,
    toolCallId: call,
    toolName: 'search_library',
    content: [{ type: 'text' as const, text: given.text === undefined ? '{}' : given.text }],
    isError: given.isError === true,
    durationMs: 42,
    timestamp: 1_000 + id,
  }
  return entry(id, 'pi.tool-result', {
    model: given.details === undefined ? base : { ...base, details: given.details },
    data: { diagnostics: [] },
  })
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
const responded = (
  id: number,
  outcome: 'completed' | 'failed' | 'aborted',
  inputs: ReadonlyArray<readonly [submission: number, entry: number]>,
) =>
  entry(id, RESPONSE_ENTRY, {
    data: {
      startedAt: 5_000,
      finishedAt: 9_000,
      toolCallCount: 0,
      usage,
      outcome,
      inputs: inputs.map(([submission, at]) => ({ submission, entry: at })),
    },
  })

const ran = (id: number, inputs: ReadonlyArray<readonly [submission: number, entry: number]>) =>
  entry(id, RUN_ENTRY, {
    data: { inputs: inputs.map(([submission, at]) => ({ submission, entry: at })) },
  })

const view = (entries: ReadonlyArray<EntryRecord>, docs: Viewed['docs'] = {}): Viewed => ({
  entries,
  docs,
})
const running = (inputs: ReadonlyArray<number>, partial: ReadonlyArray<JsonObject> = []) => ({
  'pi.live': {
    run: { taskId: 9, inputs: [...inputs] },
    generation: { attempt: 1, message: { content: [...partial] } },
  },
})

const decodeState = Schema.decodeUnknownEffect(ConversationState)

describe('a conversation as a screen reads it', () => {
  it('draws a Person’s words and pictures, and never the picture’s bytes', () => {
    const state = project(
      view([
        entry(3, 'pi.user', {
          model: {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', data: 'QkFTRTY0QllURVM=', mimeType: 'image/png' },
            ],
            timestamp: 1_700_000_000_000,
          },
        }),
      ]),
    )
    expect(state.messages).toEqual([
      {
        id: 'entry-3',
        role: 'user',
        purpose: 'user',
        display: 'visible',
        timestamp: '2023-11-14T22:13:20.000Z',
        parts: [
          { type: 'text', text: 'what is this?', state: 'done' },
          { type: 'file', mediaType: 'image/png', url: 'attachments/3-1' },
        ],
      },
    ])
    expect(JSON.stringify(state)).not.toContain('QkFTRTY0')
  })

  it('draws a signal with the values the clients tell a shared message and a wake by', () => {
    const state = project(
      view([signalled(4, 'message', { from: 'Grace', turn: '2' }, 'is <this> due?')]),
    )
    expect(state.messages).toEqual([
      {
        id: 'entry-4',
        role: 'system',
        purpose: 'dispatch',
        display: 'diagnostic',
        signal: { tagName: 'message', attributes: { from: 'Grace', turn: '2' } },
        timestamp: new Date(1_004).toISOString(),
        parts: [{ type: 'text', text: 'is <this> due?', state: 'done' }],
      },
    ])
  })

  it('draws one reply for one run, with its tool steps inside and its times', () => {
    const call = fauxToolCall('search_library', { query: 'report' }, { id: 'call-1' })
    const failed = fauxToolCall('notify_person', { title: 'Due' }, { id: 'call-2' })
    const state = project(
      view([
        said(1, 'find the report'),
        answered(
          2,
          fauxAssistantMessage([fauxText('Looking.'), call, failed], {
            stopReason: 'toolUse',
            timestamp: 2_000,
          }),
        ),
        resulted(3, 'call-1', {
          details: { customTool: 'search_library', output: { ok: true, results: [1, 2] } },
        }),
        resulted(4, 'call-2', { text: 'The server could not be reached.', isError: true }),
        answered(5, fauxAssistantMessage('Found it.')),
        responded(6, 'completed', [[70, 1]]),
      ]),
    )
    expect(state.messages.map((message) => message.id)).toEqual(['entry-1', 'run-1'])
    expect(state.messages[0]).toMatchObject({ submissionId: '70' })
    expect(state.messages[1]).toEqual({
      id: 'run-1',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      submissionId: '70',
      timestamp: new Date(2_000).toISOString(),
      metadata: { startedAt: 5_000, finishedAt: 9_000 },
      parts: [
        { type: 'text', text: 'Looking.', state: 'done' },
        {
          type: 'dynamic-tool',
          toolName: 'search_library',
          toolCallId: 'call-1',
          input: { query: 'report' },
          state: 'output-available',
          // What a screen decodes is the tool's own output, not the receipt around it.
          output: { ok: true, results: [1, 2] },
          durationMs: 42,
        },
        {
          type: 'dynamic-tool',
          toolName: 'notify_person',
          toolCallId: 'call-2',
          input: { title: 'Due' },
          state: 'output-error',
          errorText: 'The server could not be reached.',
          durationMs: 42,
        },
        { type: 'text', text: 'Found it.', state: 'done' },
      ],
    })
    expect(state.settlements).toEqual([
      { submissionId: '70', outcome: 'completed', answeredBy: '70' },
    ])
    expect(state.working).toBe(false)
  })

  it('shows the reply being written as the same message it is once committed', () => {
    const call = fauxToolCall('search_library', { query: 'report' }, { id: 'call-1' })
    const started = [
      said(1, 'find the report'),
      answered(2, fauxAssistantMessage(call, { stopReason: 'toolUse' })),
    ]
    const asked = project(view(started, running([70])))
    expect(asked.working).toBe(true)
    expect(asked.messages.at(-1)).toMatchObject({
      id: 'run-1',
      submissionId: '70',
      parts: [{ type: 'dynamic-tool', state: 'input-available' }],
    })

    const written = [...started, resulted(3, 'call-1', { text: 'two results' })]
    const streaming = project(
      view(
        written,
        running(
          [70],
          [
            { type: 'thinking', thinking: 'hm' },
            { type: 'text', text: 'Fou' },
          ],
        ),
      ),
    )
    expect(streaming.messages.at(-1)).toMatchObject({
      id: 'run-1',
      parts: [
        // A tool with no receipt shows its lone text as a string.
        { type: 'dynamic-tool', state: 'output-available', output: 'two results' },
        { type: 'reasoning', text: 'hm', state: 'streaming' },
        { type: 'text', text: 'Fou', state: 'streaming' },
      ],
    })

    const committed = project(view([...written, answered(4, fauxAssistantMessage('Found it.'))]))
    expect(committed.messages.map((message) => message.id)).toEqual(['entry-1', 'run-1'])
    expect(committed.messages.at(-1)).toMatchObject({
      parts: [{ type: 'dynamic-tool' }, { type: 'text', text: 'Found it.', state: 'done' }],
    })
    // A partial left behind by a run that is no longer answering is not drawn.
    expect(
      project(view(written, { 'pi.live': { generation: { message: { content: [] } } } })).working,
    ).toBe(false)
  })

  it('says a reply failed or was stopped as the advisory the clients read', () => {
    const state = project(
      view([
        said(1, 'one'),
        answered(2, fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 SECRET' })),
        responded(3, 'failed', [[70, 1]]),
        said(4, 'two'),
        responded(5, 'aborted', [[71, 4]]),
      ]),
    )
    expect(state.messages.map((message) => [message.id, message.purpose])).toEqual([
      ['entry-1', 'user'],
      ['end-1', 'advisory'],
      ['entry-4', 'user'],
      ['end-4', 'advisory'],
    ])
    expect(state.messages[1]).toMatchObject({
      role: 'system',
      display: 'diagnostic',
      settlement: { outcome: 'failed' },
      submissionId: '70',
    })
    expect(state.messages[3]).toMatchObject({ settlement: { outcome: 'aborted' } })
    expect(state.settlements).toEqual([
      { submissionId: '70', outcome: 'failed' },
      { submissionId: '71', outcome: 'aborted' },
    ])
    expect(JSON.stringify(state)).not.toContain('SECRET')
  })

  it('leaves out an attempt the model made again, and the calls of one that never ran', () => {
    const never = fauxToolCall('notify_person', { title: 'Sent' }, { id: 'call-x' })
    const entries = [
      said(1, 'send it'),
      answered(
        2,
        fauxAssistantMessage([fauxText('The message was sent.'), never], {
          stopReason: 'error',
          errorMessage: '503 overloaded',
        }),
      ),
    ]
    // While it is the last thing written and Pi waits to try again, the unfinished words show,
    // without the call.
    const backingOff = {
      'pi.live': {
        run: { taskId: 9, inputs: [70] },
        generation: { attempt: 1, retry: { at: 5, error: 'x' } },
      },
    }
    expect(project(view(entries, backingOff)).messages.at(-1)).toMatchObject({
      parts: [{ type: 'text', text: 'The message was sent.', state: 'done' }],
    })
    const retried = project(
      view([...entries, answered(3, fauxAssistantMessage('I could not send it.'))]),
    )
    expect(retried.messages.at(-1)).toMatchObject({
      id: 'run-1',
      parts: [{ type: 'text', text: 'I could not send it.', state: 'done' }],
    })
  })

  it('keeps a reply one message after its run ended and before its response is recorded', () => {
    const call = fauxToolCall('search_library', {}, { id: 'call-1' })
    // What the transcript holds in the moment after the settling commit: the run's own record
    // of its deliveries, no live run, and no response entry yet.
    const state = project(
      view([
        said(1, 'one'),
        ran(2, [[70, 1]]),
        answered(3, fauxAssistantMessage(call, { stopReason: 'toolUse' })),
        resulted(4, 'call-1', {}),
        said(5, 'two'),
        ran(6, [
          [70, 1],
          [71, 5],
        ]),
        answered(7, fauxAssistantMessage('both')),
      ]),
    )
    expect(state.messages.map((message) => [message.id, message.submissionId])).toEqual([
      ['entry-1', '70'],
      ['run-1', '70'],
      ['entry-5', '71'],
    ])
    expect(state.messages[1]).toMatchObject({
      parts: [{ type: 'dynamic-tool' }, { type: 'text', text: 'both' }],
    })
  })

  it('stops showing a failed attempt once the next attempt has begun to arrive', () => {
    const entries = [
      said(1, 'send it'),
      answered(
        2,
        fauxAssistantMessage('The message was sent.', {
          stopReason: 'error',
          errorMessage: '503 overloaded',
        }),
      ),
    ]
    const retrying = project(view(entries, running([70], [{ type: 'text', text: 'I could not' }])))
    expect(retrying.messages.at(-1)).toMatchObject({
      id: 'run-1',
      parts: [{ type: 'text', text: 'I could not', state: 'streaming' }],
    })
  })

  it('shows a failed attempt while Pi waits to try again, and not once it is trying', () => {
    const entries = [
      said(1, 'send it'),
      ran(2, [[70, 1]]),
      answered(
        3,
        fauxAssistantMessage('The message was sent.', {
          stopReason: 'error',
          errorMessage: '503 overloaded',
        }),
      ),
    ]
    const live = (generation: JsonObject) => ({
      'pi.live': { run: { taskId: 9, inputs: [70] }, generation },
    })
    // Backing off: the failed attempt is still the newest thing there is.
    const waiting = project(view(entries, live({ attempt: 1, retry: { at: 5, error: 'x' } })))
    expect(waiting.messages.map((message) => message.id)).toEqual(['entry-1', 'run-1'])
    // The next request has begun and has said nothing yet: the failed words are gone already.
    const trying = project(view(entries, live({ attempt: 2 })))
    expect(trying.messages.map((message) => message.id)).toEqual(['entry-1'])
    expect(trying.working).toBe(true)
  })

  it('says how a reply ended from Pi\u2019s own record when no response entry was written', () => {
    const entries = [
      said(1, 'one'),
      ran(2, [[70, 1]]),
      answered(3, fauxAssistantMessage('done')),
      said(4, 'two'),
      ran(5, [[71, 4]]),
      answered(6, fauxAssistantMessage('half', { stopReason: 'error', errorMessage: '401' })),
    ]
    const state = project({
      entries,
      docs: {},
      outcomes: new Map([
        [70, 'completed'],
        [71, 'failed'],
      ]),
    })
    expect(state.settlements).toEqual([
      { submissionId: '70', outcome: 'completed', answeredBy: '70' },
      { submissionId: '71', outcome: 'failed' },
    ])
    expect(state.messages.map((message) => [message.id, message.purpose])).toEqual([
      ['entry-1', 'user'],
      ['run-1', 'assistant'],
      ['entry-4', 'user'],
      ['run-4', 'assistant'],
      ['end-4', 'advisory'],
    ])
    expect(state.messages.at(-1)).toMatchObject({
      settlement: { outcome: 'failed' },
      submissionId: '71',
    })
  })

  it('shows no tool call from a message that did not stop to use tools', () => {
    const never = fauxToolCall('show', { kind: 'choices' }, { id: 'call-x' })
    const state = project(
      view([
        said(1, 'pick one'),
        answered(2, fauxAssistantMessage([fauxText('Here are'), never], { stopReason: 'length' })),
      ]),
    )
    expect(state.messages.at(-1)).toMatchObject({
      id: 'run-1',
      parts: [{ type: 'text', text: 'Here are', state: 'done' }],
    })
    expect(state.messages.flatMap((message) => message.parts)).toHaveLength(2)
  })

  it('gives each round of tools its own results when a call id is used again', () => {
    const again = () => fauxToolCall('read', { path: 'a' }, { id: 'same-id' })
    const state = project(
      view([
        said(1, 'read it twice'),
        answered(2, fauxAssistantMessage(again(), { stopReason: 'toolUse' })),
        resulted(3, 'same-id', { text: 'first' }),
        answered(4, fauxAssistantMessage(again(), { stopReason: 'toolUse' })),
        resulted(5, 'same-id', { text: 'second failed', isError: true }),
      ]),
    )
    expect(state.messages.at(-1)).toMatchObject({
      parts: [
        { state: 'output-available', output: 'first' },
        { state: 'output-error', errorText: 'second failed' },
      ],
    })
  })

  it('shows a tool\u2019s content, as main did, when its details are not a receipt', () => {
    const call = fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' })
    const state = project(
      view([
        said(1, 'read it'),
        answered(2, fauxAssistantMessage(call, { stopReason: 'toolUse' })),
        resulted(3, 'call-1', { text: 'the file', details: { path: 'notes.txt', lines: 1 } }),
      ]),
    )
    expect(state.messages.at(-1)).toMatchObject({
      parts: [{ state: 'output-available', output: 'the file' }],
    })
  })

  it('keeps a delivery that joined a reply in that reply, and counts what is still waiting', () => {
    const call = fauxToolCall('search_library', {}, { id: 'call-1' })
    const entries = [
      said(1, 'one'),
      answered(2, fauxAssistantMessage(call, { stopReason: 'toolUse' })),
      resulted(3, 'call-1', {}),
      said(4, 'two'),
    ]
    const live = project(
      view(entries, {
        ...running([70, 71]),
        'pi.inbox': {
          items: [
            { id: 72, mode: 'steer' },
            { id: 73, mode: 'write' },
          ],
        },
      }),
    )
    // One run: the second delivery is drawn after the reply it joined, not as a new reply.
    expect(live.messages.map((message) => [message.id, message.submissionId])).toEqual([
      ['entry-1', '70'],
      ['run-1', '70'],
      ['entry-4', '71'],
    ])
    expect(live.queued).toBe(1)

    const ended = project(
      view([
        ...entries,
        answered(5, fauxAssistantMessage('both')),
        responded(6, 'completed', [
          [70, 1],
          [71, 4],
        ]),
      ]),
    )
    expect(ended.messages.map((message) => message.id)).toEqual(['entry-1', 'run-1', 'entry-4'])
    expect(ended.messages[1]).toMatchObject({
      parts: [{ type: 'dynamic-tool' }, { type: 'text', text: 'both' }],
    })
    expect(ended.settlements).toEqual([
      { submissionId: '70', outcome: 'completed', answeredBy: '70' },
      { submissionId: '71', outcome: 'completed', answeredBy: '70' },
    ])
  })

  it('never shows the instruction, a Person’s id, or any document but the live one', () => {
    const state = project(
      view(
        [
          entry(1, 'pi.system', {
            model: {
              role: 'system',
              content: '',
              sections: { vivid: 'PROMPT-MARK' },
              timestamp: 1,
            },
          }),
          said(2, 'hello'),
          entry(3, 'pi.compaction', {
            model: { role: 'user', content: 'SUMMARY-MARK', timestamp: 3 },
            data: { reason: 'threshold' },
          }),
          entry(4, 'pi.reset'),
          entry(5, 'vivid.placed'),
          answered(6, fauxAssistantMessage('hi')),
        ],
        {
          'pi.agent': { instructions: 'AGENT-MARK', cwd: '/home/DISK-MARK' },
          'pi.provider': { sessionId: 'SESSION-MARK' },
          'vivid.conversation': { threadId: 't', creator: 'PERSON-MARK', creatorName: 'Ada' },
          'vivid.delivery': { kept: 'KEPT-MARK' },
        },
      ),
    )
    expect(state.messages.map((message) => message.id)).toEqual(['entry-2', 'run-2'])
    expect(JSON.stringify(state)).not.toMatch(/-MARK/u)
  })

  it('gives back the messages of a run that did not change', () => {
    const next = projector()
    const first = [
      said(1, 'one'),
      answered(2, fauxAssistantMessage('first')),
      responded(3, 'completed', [[70, 1]]),
    ]
    const before = next(view(first))
    const after = next(
      view([...first, said(4, 'two')], running([71], [{ type: 'text', text: 'se' }])),
    )
    expect(after.messages[0]).toBe(before.messages[0])
    expect(after.messages[1]).toBe(before.messages[1])
    expect(after.messages).toHaveLength(4)
  })
})

/** What can happen to a conversation, one step at a time. */
const Step = Schema.Literals([
  'message',
  'signal',
  'word',
  'tool',
  'result',
  'answer',
  'fail',
  'stop',
])

/** The model's state: the run answering, the words it has so far, the call it waits on, the queue. */
interface Simulated {
  working: boolean
  run: Array<readonly [submission: number, entry: number]>
  words: string
  call: string
  waiting: number[]
}

/**
 * A small model of Pi's side: it applies steps the way Pi's run control does (a delivery during
 * a run waits; a tool round's end places what waited; an answer or a failure ends the run and the
 * runtime writes its response entry) and yields the view after each step that changed anything.
 */
function* activity(steps: ReadonlyArray<typeof Step.Type>): Generator<Viewed> {
  const entries: EntryRecord[] = []
  const counter = { entry: 0, submission: 100, call: 0 }
  const live: Simulated = { working: false, run: [], words: '', call: '', waiting: [] }
  const id = () => (counter.entry += 1)
  const place = (submission: number, signal: boolean) => {
    const at = id()
    entries.push(signal ? signalled(at, 'schedule', { name: 'Daily' }, 'due') : said(at, `m${at}`))
    return [submission, at] as const
  }
  const end = (outcome: 'completed' | 'failed' | 'aborted') => {
    entries.push(responded(id(), outcome, live.run))
    live.working = false
    live.run = []
    live.words = ''
    if (outcome === 'aborted') live.waiting = []
    if (outcome !== 'completed' || live.waiting.length === 0) return
    live.working = true
    live.run = live.waiting.map((submission) => place(submission, false))
    live.waiting = []
  }
  for (const step of steps) {
    if (step === 'message' || step === 'signal') {
      const submission = (counter.submission += 1)
      if (live.working) live.waiting.push(submission)
      else {
        live.working = true
        live.run = [place(submission, step === 'signal')]
      }
    } else if (!live.working) continue
    else if (step === 'result') {
      if (live.call === '') continue
      entries.push(
        resulted(id(), live.call, {
          isError: counter.call % 2 === 0,
          details: { customTool: 'search_library', output: { n: counter.call } },
        }),
      )
      live.call = ''
      live.run.push(...live.waiting.map((submission) => place(submission, false)))
      live.waiting = []
    } else if (live.call !== '') continue
    else if (step === 'word') live.words += ' word'
    else if (step === 'tool') {
      live.call = `call-${(counter.call += 1)}`
      const call = fauxToolCall('search_library', { n: counter.call }, { id: live.call })
      entries.push(
        answered(
          id(),
          fauxAssistantMessage(live.words === '' ? call : [fauxText(live.words), call], {
            stopReason: 'toolUse',
            timestamp: 0,
          }),
        ),
      )
      live.words = ''
    } else if (step === 'answer') {
      entries.push(answered(id(), fauxAssistantMessage(`${live.words} done`, { timestamp: 0 })))
      end('completed')
    } else end(step === 'fail' ? 'failed' : 'aborted')
    const generation = { message: { content: [{ type: 'text', text: live.words }] } }
    yield {
      entries: [...entries],
      docs: {
        'pi.live': live.working
          ? { run: { taskId: 1, inputs: live.run.map(([submission]) => submission) }, generation }
          : {},
        'pi.inbox': {
          items: live.waiting.map((submission) => ({ id: submission, mode: 'steer' })),
        },
      },
    }
  }
}

describe('the frames of a conversation', () => {
  it.effect.prop(
    'applying every change in order to the whole state gives the state of the current view',
    { steps: Schema.Array(Step).check(Schema.isMaxLength(40)) },
    ({ steps }) =>
      Effect.gen(function* () {
        const next = projector()
        let replica: Projected = next({ entries: [], docs: {} })
        ConversationFrame.cases.Whole.make({ state: replica })
        let previous = replica
        for (const current of activity(steps)) {
          const state = next(current)
          const ops = diffRevisions(previous, state)
          for (const op of ops) assertValidOp(op)
          ConversationFrame.cases.Changes.make({ ops })
          replica = applyImmutable(replica, ops)
          previous = state
          // The remembering projector, the diff and the replay all agree with the pure reading.
          expect(replica).toEqual(project(current))
          yield* decodeState(replica)
        }
      }),
    { arbitrary: { seed: 20_261_014, runs: 300 } },
  )
})
