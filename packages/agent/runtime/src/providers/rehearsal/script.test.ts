import { createParser } from '@openuidev/lang-core'
import { describe, expect, it } from '@effect/vitest'
import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { CodeFailure, DesktopAction, UseDesktopRequest } from '@vivid/contracts'
import { validateToolArguments } from '@earendil-works/pi-ai'
import * as NodeChildProcess from 'node:child_process'
import { Option, Schema } from 'effect'
import * as v from 'valibot'
import { askTools } from '../../tools/ask.ts'
import { documentTools } from '../../tools/documents.ts'
import { codeTools } from '../../tools/code.ts'
import { pictureTools } from '../../tools/computer.ts'
import { connectionTools } from '../../tools/connections.ts'
import { memoryTools } from '../../tools/memory.ts'
import { routineTools } from '../../tools/routines.ts'
import type { RunTool } from '../../tools/scope.ts'
import { phrases, script } from './script.ts'
import spec from '../../agents/parts.json' with { type: 'json' }

/** Inspect the definitions' own schemas; execution through this runner would be a test defect. */
const unavailable: RunTool = () =>
  Promise.reject(new Error('Schema inspection must not execute tools'))
const tools = [
  ...askTools(unavailable),
  ...codeTools(unavailable),
  ...documentTools(unavailable),
  ...connectionTools(unavailable),
  ...memoryTools(unavailable),
  ...routineTools(unavailable),
]
const nativeTools = pictureTools(unavailable)
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

/**
 * Each registration case starts a Node process that boots Vite and loads the provider cold: about
 * two seconds on an idle machine, and past the default five when several gates share its cores
 * (6.6 s and 16 s measured on the Cloudbox, 6 Oct 2026). This is a ceiling for that start, not a
 * wait: nothing here sleeps.
 */
const coldProcess = 30_000

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
    timeout: coldProcess,
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

/** OpenUI's parser reads the program out of its fence itself, as the surfaces' renderer does. */
const displayParser = createParser(spec.schema, spec.root)
const wordsOf = (block: { readonly type: string; readonly text?: string }) =>
  block.type === 'text' && block.text !== undefined ? block.text : ''

describe('Rehearsal scenes', () => {
  for (const phrase of phrases) {
    it(`${phrase}: real schemas accept every tool input and context advances the step`, () => {
      const start = context(`Please ${phrase.toUpperCase()} for this rehearsal`)
      const first = script(start)
      const calls = first.content.filter((block) => block.type === 'toolCall')
      if (phrase.startsWith('show ')) {
        // A display is part of the reply, not a call: its program must be one OpenUI draws whole.
        expect(calls).toEqual([])
        expect(first.stopReason).toBe('stop')
        const drawn = displayParser.parse(first.content.map(wordsOf).join(''))
        expect(drawn.root).not.toBeNull()
        expect(drawn.meta.errors).toEqual([])
        expect(drawn.meta.unresolved).toEqual([])
        expect(script(start)).toEqual(first)
        return
      }
      expect(calls.length).toBe(phrase === 'two things' ? 2 : 1)
      expect(first.stopReason).toBe('toolUse')
      expect(script(start)).toEqual(first)
      for (const call of calls) {
        const native = nativeTools.find((candidate) => candidate.name === call.name)
        if (native !== undefined) {
          expect(validateToolArguments(native, call)).toEqual(call.arguments)
          if (call.name === 'use_desktop')
            expect(decodeDesktop(call.arguments).action).toEqual(DesktopAction.cases.Look.make({}))
          continue
        }
        const tool = tools.find((candidate) => candidate.name === call.name)
        expect(tool, call.name).toBeDefined()
        if (tool === undefined) throw new Error(`Missing schema for ${call.name}`)
        expect(v.safeParse(tool.input, call.arguments).success).toBe(true)
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
      expect(following.content.some((block) => block.type === 'toolCall')).toBe(false)
      expect(words(following)).toContain('That part of Vivid is not available right now.')
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
        phrase: 'write a document',
        output: { ok: true, title: 'Actual plan', version: 1, created: true, changed: true },
        expected: 'I wrote “Actual plan” at version 1.',
      },
      {
        phrase: 'revise the document',
        output: { ok: true, title: 'Actual plan', version: 2, created: false, changed: true },
        expected: 'I revised “Actual plan” at version 2.',
      },
      {
        phrase: 'revise the document',
        output: { ok: true, title: 'Actual plan', version: 2, created: false, changed: false },
        expected: 'The document “Actual plan” is unchanged at version 2.',
      },
      {
        phrase: 'read the document',
        output: { ok: true, title: 'Actual plan', version: 2, body: '# Revised' },
        expected: 'I read “Actual plan” at version 2.',
      },
      {
        phrase: 'read the document',
        output: { ok: false, titles: ['Other'], message: 'No document has that title.' },
        expected: 'That didn’t finish: No document has that title.',
      },
      {
        phrase: 'remind me',
        output: { name: 'Reminder', nextRunAt: '2026-10-04T08:00:00Z' },
        expected: 'The reminder is scheduled for 2026-10-04T08:00:00Z as a one-off Routine.',
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
    }
  })

  it('does not leak mutable scene inputs or progress across different contexts', () => {
    const start = context('write a document')
    const expected = script(start)
    const changed = script(start)
    const call = changed.content.find((block) => block.type === 'toolCall')
    if (call === undefined) throw new Error('Expected a document call')
    call.arguments.title = 'Changed'
    script(context('run a program'))
    expect(script(start)).toEqual(expected)
  })

  it('keeps document scenes and their receipts anchored to the Person across Flue instruction markers', () => {
    const marker = {
      role: 'user',
      content: '<signal type="instructions">\nSystem instructions updated.\n</signal>',
      timestamp,
    } as const
    for (const phrase of ['write a document', 'revise the document', 'read the document']) {
      const start = context(phrase)
      const first = script({ ...start, messages: [...start.messages, marker] })
      const call = first.content.find((block) => block.type === 'toolCall')
      if (call === undefined) throw new Error('Expected document call')
      expect(call.name).toBe(phrase === 'read the document' ? 'read_document' : 'write_document')
      const result = receipt(
        call,
        phrase === 'read the document'
          ? { ok: true, title: 'Plan', version: 2, body: '# Plan' }
          : { ok: true, title: 'Plan', version: 2, created: false, changed: true },
      )
      const completed = script({
        ...start,
        messages: [...start.messages, marker, first, result, marker],
      })
      expect(words(completed)).toContain('“Plan” at version 2.')
      expect(completed.stopReason).toBe('stop')
      expect(completed.content.some((block) => block.type === 'toolCall')).toBe(false)
    }
  })

  it('returns a reply when scene receipts are missing or empty', () => {
    for (const phrase of phrases) {
      const start = context(phrase)
      const first = script(start)
      const calls = first.content.filter((block) => block.type === 'toolCall')
      for (const results of [[], calls.map((call) => receipt(call, {}))]) {
        const reply = script({ ...start, messages: [...start.messages, first, ...results] })
        expect(words(reply)).not.toBe('')
      }
    }
  })

  it('does not invent a scene for unknown, empty or picture-only messages', () => {
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
      expect(output.stopReason).toBe('stop')
      expect(words(output)).not.toBe('')
      expect(output.content.some((block) => block.type === 'toolCall')).toBe(false)
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
    expect(
      next.content.some((block) => block.type === 'text' && block.text.includes('```openui-lang')),
    ).toBe(true)
  })

  it('schedules tomorrow at 09:00 in the context timezone, including month and year rollover', () => {
    const start = context('remind me')
    const first = script(start)
    expect(first.content).toMatchObject([
      {
        arguments: { trigger: { kind: 'Once', localAt: '2026-10-04T09:00' } },
      },
    ])
    const rollover = script({
      systemPrompt: 'Today is Thursday 31 December 2026 in the Pacific/Auckland time zone.',
      messages: [
        { role: 'user', content: 'remind me', timestamp: Date.parse('2026-12-31T10:30:00Z') },
      ],
    })
    expect(rollover.content).toMatchObject([
      { arguments: { trigger: { kind: 'Once', localAt: '2027-01-01T09:00' } } },
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

  it(
    'does not register without explicit opt-in for absent, unrelated or similarly named models',
    () => {
      for (const model of [
        Option.none<string>(),
        Option.some('openrouter/z-ai/glm-5.3-flash'),
        Option.some('rehearsalish/script'),
      ]) {
        expect(
          registration(model),
          Option.getOrElse(model, () => 'no model'),
        ).toBe('{"registered":false,"model":null}')
      }
    },
    coldProcess * 3,
  )
  it(
    'registers exactly the opt-in script model through Flue',
    () => {
      expect(registration(Option.some('rehearsal/script'))).toBe(
        '{"registered":true,"model":"script"}',
      )
    },
    coldProcess,
  )
})
