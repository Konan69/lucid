import { describe, expect, it } from '@effect/vitest'
import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { CodeFailure, DesktopAction, Shown, UseDesktopRequest } from '@vivid/contracts'
import * as NodeChildProcess from 'node:child_process'
import { Option, Schema } from 'effect'
import * as v from 'valibot'
import { askTools } from '../../tools/ask.ts'
import { codeTools } from '../../tools/code.ts'
import { computerDefinitions } from '../../tools/computer.ts'
import { connectionTools } from '../../tools/connections.ts'
import { memoryTools } from '../../tools/memory.ts'
import { routineTools } from '../../tools/routines.ts'
import { showTools } from '../../tools/show.ts'
import { taskTools } from '../../tools/tasks.ts'
import type { RunTool } from '../../tools/scope.ts'
import { phrases, script } from './script.ts'

/** Inspect the definitions' own schemas; execution through this runner would be a test defect. */
const unavailable: RunTool = () =>
  Promise.reject(new Error('Schema inspection must not execute tools'))
const tools = [
  ...askTools(unavailable),
  ...codeTools(unavailable),
  ...computerDefinitions(unavailable),
  ...connectionTools(unavailable),
  ...memoryTools(unavailable),
  ...routineTools(unavailable),
  ...showTools(),
  ...taskTools(unavailable),
]
const decodeShown = Schema.decodeUnknownSync(Shown)
const decodeDesktop = Schema.decodeUnknownSync(UseDesktopRequest)
const timestamp = Date.parse('2026-10-03T14:00:00Z')

/** Context fixtures preserve a prior turn, so scene selection and step counts must use the latest Person message. */
function context(phrase: string): Context {
  return {
    systemPrompt: 'Today is Saturday 3 October 2026 in the Africa/Lagos time zone.',
    messages: [
      { role: 'user', content: 'run a program', timestamp: timestamp - 1000 },
      {
        ...script({
          messages: [{ role: 'user', content: 'unknown', timestamp: timestamp - 1000 }],
        }),
      },
      { role: 'user', content: phrase, timestamp },
    ],
  }
}

/** Results are delivered through pi's public Context shape, exactly as the real tools return them. */
function receipt(call: ToolCall, output: Schema.Json): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    isError: false,
    timestamp,
  }
}

/** Only model text is observable prose; tool argument identifiers never count as product wording. */
function words(message: AssistantMessage) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Check each authored sentence, including a second receipt joined into the same reply. */
function expectCapitalSentences(message: AssistantMessage) {
  for (const block of message.content.filter((content) => content.type === 'text')) {
    for (const sentence of block.text.split(/[.!?]\s+/u)) {
      expect(sentence).toMatch(/^[A-Z]/u)
    }
  }
}

/** Isolated Node processes prove import-time opt-in against Flue's real registry without module mocks or global env changes. */
function registration(model: Option.Option<string>) {
  const env = { ...process.env }
  delete env.VIVID_MODEL
  if (Option.isSome(model)) env.VIVID_MODEL = model.value
  const module = new URL('../rehearsal.ts', import.meta.url).href
  const code = `import { createServer } from 'vite';
    import { hasProvider, resolveModel } from '@flue/runtime/internal';
    const bundler = await createServer({ configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null } });
    await bundler.ssrLoadModule(${JSON.stringify(module.replace('file://', ''))});
    console.log(JSON.stringify({ registered: hasProvider('rehearsal'), model: hasProvider('rehearsal') ? resolveModel('rehearsal/script').id : null }));
    await bundler.close();`
  const result = NodeChildProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('../../../', import.meta.url),
    env,
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe('Rehearsal scenes', () => {
  for (const phrase of phrases) {
    it(`${phrase}: real schemas accept every tool input and context advances the step`, () => {
      const start = context(`Please ${phrase.toUpperCase()} for this rehearsal`)
      const first = script(start)
      expectCapitalSentences(first)
      const calls = first.content.filter((block) => block.type === 'toolCall')
      expect(calls.length).toBe(phrase === 'two things' ? 2 : 1)
      expect(first.stopReason).toBe('toolUse')
      expect(script(start)).toEqual(first)
      for (const call of calls) {
        if (call.name === 'use_desktop') {
          expect(decodeDesktop(call.arguments).action).toEqual(DesktopAction.cases.Look.make({}))
          continue
        }
        const tool = tools.find((candidate) => candidate.name === call.name)
        expect(tool, call.name).toBeDefined()
        if (tool === undefined) throw new Error(`Missing schema for ${call.name}`)
        expect(v.safeParse(tool.input, call.arguments).success).toBe(true)
        if (call.name === 'show') decodeShown(call.arguments.show)
      }
      const following = script({
        ...start,
        messages: [
          ...start.messages,
          first,
          ...calls.map((call) =>
            receipt(call, { ok: false, message: 'That part of Vivid is not available right now.' }),
          ),
        ],
      })
      expect(following.stopReason).toBe('stop')
      expectCapitalSentences(following)
      expect(following.content.some((block) => block.type === 'toolCall')).toBe(false)
      expect(words(following)).toContain('That part of Vivid is not available right now.')
      expect(words(first) + words(following)).not.toMatch(/\bagent\b|rehearsal:|MARK-/iu)
    })
  }

  it('uses actual page titles and program results, including two simultaneous receipts', () => {
    const start = context('two things')
    const first = script(start)
    const calls = first.content.filter((block) => block.type === 'toolCall')
    const outputs = calls.map((call) =>
      receipt(
        call,
        call.name === 'read_page'
          ? { ok: true, title: 'A different page title' }
          : { ok: true, result: 17 },
      ),
    )
    expect(words(script({ ...start, messages: [...start.messages, first, ...outputs] }))).toBe(
      'The page is titled “A different page title”. The sum is 17.',
    )
    expect(new Set(calls.map((call) => call.id)).size).toBe(2)
  })

  it('reports receipt-backed outcomes for displays, records, integrations and the Computer', () => {
    const cases: readonly { phrase: string; output: Schema.Json; expected: string }[] = [
      {
        phrase: 'show a table',
        output: { ok: true, shown: 'table' },
        expected: 'The table is above.',
      },
      {
        phrase: 'add a task',
        output: { task: { title: 'Actual saved task' } },
        expected: 'I added “Actual saved task”.',
      },
      {
        phrase: 'remind me',
        output: { name: 'Reminder', nextRunAt: '2026-10-04T08:00:00Z' },
        expected:
          'The reminder is scheduled for 2026-10-04T08:00:00Z; this date-based routine repeats yearly until removed.',
      },
      {
        phrase: 'remember that',
        output: { ok: true, remembered: 'A confirmed preference.' },
        expected: 'I remembered: A confirmed preference.',
      },
      {
        phrase: 'find google',
        output: { catalog: 'available', integrations: [{ name: 'Google Calendar' }] },
        expected: 'The search returned 1 matches: Google Calendar.',
      },
      {
        phrase: 'find google',
        output: { catalog: 'unavailable', integrations: [] },
        expected: 'The integration catalogue is unavailable right now.',
      },
      {
        phrase: 'add exa',
        output: { added: true, account: 'Exa' },
        expected: 'I added the Exa integration.',
      },
      {
        phrase: 'add exa',
        output: { added: false, reason: 'No integration found.' },
        expected: 'That didn’t finish: No integration found.',
      },
      {
        phrase: 'browse example',
        output: { ok: true, result: { title: 'Example Domain' } },
        expected: 'The browser opened “Example Domain”; open the computer to see it.',
      },
      {
        phrase: 'use the desktop',
        output: { ok: true, view: { width: 1440, height: 900 } },
        expected: 'The computer returned a 1440 by 900 screenshot.',
      },
      {
        phrase: 'remember that',
        output: { ok: false, message: 'That part of Vivid is not available right now.' },
        expected: 'I couldn’t save that memory: That part of Vivid is not available right now.',
      },
    ]
    for (const example of cases) {
      const start = context(example.phrase)
      const first = script(start)
      const call = first.content.find((block) => block.type === 'toolCall')
      if (call === undefined) throw new Error('Expected a tool call')
      const result = script({
        ...start,
        messages: [...start.messages, first, receipt(call, example.output)],
      })
      expect(words(result)).toBe(example.expected)
      expectCapitalSentences(result)
    }
  })

  it('does not leak mutable scene inputs or progress across different contexts', () => {
    const start = context('show a table')
    const expected = script(start)
    const changed = script(start)
    const call = changed.content.find((block) => block.type === 'toolCall')
    if (call === undefined) throw new Error('Expected a display call')
    call.arguments.show = { changed: true }
    script(context('run a program'))
    expect(script(start)).toEqual(expected)
  })

  it('capitalizes missing-result replies for every scene', () => {
    for (const phrase of phrases) {
      const start = context(phrase)
      const first = script(start)
      const calls = first.content.filter((block) => block.type === 'toolCall')
      for (const results of [[], calls.map((call) => receipt(call, {}))]) {
        const reply = script({ ...start, messages: [...start.messages, first, ...results] })
        expect(words(reply)).not.toBe('')
        expectCapitalSentences(reply)
      }
    }
  })

  it('lists all supported phrases for unknown, empty and picture-only messages', () => {
    for (const input of [
      context('hello'),
      { messages: [] },
      {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'image' as const, mimeType: 'image/png', data: 'rehearsal' }],
            timestamp,
          },
        ],
      },
    ]) {
      const output = script(input)
      expectCapitalSentences(output)
      expect(output.stopReason).toBe('stop')
      for (const phrase of phrases) expect(words(output)).toContain(phrase)
    }
  })

  it('resets the step after a new Person message and does not count tool receipts as assistant steps', () => {
    const start = context('read example')
    const first = script(start)
    expect(
      script({
        ...start,
        messages: [
          ...start.messages,
          {
            role: 'toolResult',
            toolCallId: 'old',
            toolName: 'read_page',
            content: [],
            isError: false,
            timestamp,
          },
        ],
      }),
    ).toMatchObject({
      stopReason: 'toolUse',
      content: [{ name: 'read_page', arguments: { address: 'https://example.com' } }],
    })
    const next = script({
      messages: [
        ...start.messages,
        first,
        { role: 'user', content: 'show a table', timestamp: timestamp + 100 },
      ],
    })
    expect(next.content.some((block) => block.type === 'toolCall' && block.name === 'show')).toBe(
      true,
    )
  })

  it('schedules tomorrow at 09:00 in the context timezone, including month and year rollover', () => {
    const start = context('remind me')
    const first = script(start)
    expect(first.content).toMatchObject([
      {
        arguments: { trigger: { kind: 'Schedule', cron: '0 9 4 10 *', timezone: 'Africa/Lagos' } },
      },
    ])
    const rollover = script({
      systemPrompt: 'Today is Thursday 31 December 2026 in the Pacific/Auckland time zone.',
      messages: [
        { role: 'user', content: 'remind me', timestamp: Date.parse('2026-12-31T10:30:00Z') },
      ],
    })
    expect(rollover.content).toMatchObject([
      { arguments: { trigger: { cron: '0 9 1 1 *', timezone: 'Pacific/Auckland' } } },
    ])
  })

  it('reports tagged failures and malformed or absent receipts without claiming success', () => {
    const start = context('run a program')
    const first = script(start)
    for (const [content, expected] of [
      [
        JSON.stringify({ ok: false, failure: CodeFailure.cases.Unavailable.make({}) }),
        'That didn’t finish: The program is unavailable.',
      ],
      ['malformed', 'I couldn’t read the result.'],
    ] as const) {
      expect(
        words(
          script({
            ...start,
            messages: [
              ...start.messages,
              { ...first },
              {
                role: 'toolResult',
                toolCallId: 'result',
                toolName: 'run_code',
                content: [{ type: 'text', text: content }],
                isError: false,
                timestamp,
              },
            ],
          }),
        ),
      ).toBe(expected)
    }
    expect(words(script({ ...start, messages: [...start.messages, first] }))).toBe(
      'I haven’t received a result yet.',
    )
  })

  for (const model of [
    Option.none<string>(),
    Option.some('openrouter/z-ai/glm-5.3-flash'),
    Option.some('rehearsalish/script'),
  ]) {
    it(`does not register without explicit opt-in (${String(model)})`, () => {
      expect(registration(model)).toBe('{"registered":false,"model":null}')
    })
  }
  it('registers exactly the opt-in script model through Flue', () => {
    expect(registration(Option.some('rehearsal/script'))).toBe(
      '{"registered":true,"model":"script"}',
    )
  })
})
