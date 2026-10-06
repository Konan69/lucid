import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, tool } from 'ai'
import { Effect } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, attachRun, history, streamRun } from '../main.ts'
import { consume, context, host, signal, texts } from './fixtures/host.ts'

/** openai-completions.js customInput stores a growing grammar string, not JSON argument scratch. */
it.live('approves customInput without exposing its partial grammar input', () =>
  Effect.promise(async () => {
    const input = 'a payment instruction '.repeat(30)
    const paid: string[] = []
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: async (args) => {
            paid.push(args.input)
            return args.input
          },
        }),
      },
      { approval: { pay: true } },
      { progress: { partialIntervalMs: 1 } },
      { partialFamily: 'custom', tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { input }, { id: 'custom' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
    ])
    let done = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => done.resolve(),
      onError: (error) => done.reject(error),
    })
    await chat.sendMessage({ text: 'Pay' })
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    const part = chat.lastMessage.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected approval')
    expect(part.input).toEqual({ input })
    expect(paid).toEqual([])
    done = signal()
    await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
    await done.promise
    expect(paid).toEqual([input])
    expect(chat.status).toBe('ready')
  }),
)

/** openai-responses-shared.js output_item.done replaces text/thinking whole and adds signatures. */
it.live(
  'reconciles Responses whole text and thinking replacements without missing or duplicate suffixes',
  () =>
    Effect.promise(async () => {
      const fixture = await host(
        {},
        {},
        { progress: { partialIntervalMs: 1 } },
        { partialFamily: 'responses', tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
      )
      const opened = await fixture.open()
      const reasoning = 'Reasoning '.repeat(30)
      const text = 'Answer '.repeat(30)
      opened.faux.setResponses([fauxAssistantMessage([fauxThinking(reasoning), fauxText(text)])])
      const result = await consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Explain', requestId: 'responses' },
          context,
        ),
      )
      expect(texts(result.message)).toEqual([text])
      expect(result.message.parts.filter((part) => part.type === 'reasoning')).toMatchObject([
        { type: 'reasoning', text: reasoning, state: 'done' },
      ])
      expect(result.chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1)
      expect(result.chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(1)
    }),
)

/** anthropic-messages.js abort strips scratch but retains truncated parsed arguments: never admit them. */
it.live(
  'aborts a parsed partial tool input without making it available or requesting approval',
  () =>
    Effect.promise(async () => {
      const input = { account: 'savings '.repeat(300), amount: 12345 }
      const fixture = await host(
        {
          pay: tool({
            inputSchema: z.object({ account: z.string(), amount: z.number() }),
            execute: async (args) => args,
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        { partialFamily: 'anthropic', tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', input, { id: 'partial' })], {
          stopReason: 'toolUse',
        }),
      ])
      const stream = await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'abort-partial' },
        context,
      )
      const [raw, folded] = stream.tee()
      const result = consume(folded)
      const started = signal()
      const drain = (async () => {
        for await (const chunk of raw) if (chunk.type === 'tool-input-start') started.resolve()
      })()
      await started.promise
      const attached = await attachRun(opened.harness, opened.root.id, context)
      if (attached.status !== 'running') throw new Error('Expected partial replay')
      const replayed = consume(attached.stream)
      await abort(opened.harness, opened.root.id, context)
      await drain
      const finished = await result
      expect((await replayed).message.parts).toEqual(finished.message.parts)
      const types = finished.chunks.map((chunk) => chunk.type)
      expect(types).toContain('tool-input-start')
      expect(types).toContain('abort')
      expect(types).not.toContain('tool-input-available')
      expect(types).not.toContain('tool-approval-request')
      expect(types.indexOf('tool-input-error')).toBeGreaterThan(types.indexOf('tool-input-start'))
      expect(types.indexOf('abort')).toBeGreaterThan(types.indexOf('tool-input-error'))
      const part = finished.message.parts.find(isToolUIPart)
      expect(part).toMatchObject({
        type: 'tool-pay',
        toolCallId: 'partial',
        state: 'output-error',
        errorText: 'Tool input was interrupted before it completed',
      })
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected aborted history')
      expect(assistant.parts).toEqual(finished.message.parts)
      const view = await opened.root.context(context)
      const recorded = view.entries
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) => (message.role === 'assistant' ? message.content : []))
        .find((block) => block.type === 'toolCall')
      expect(recorded).toMatchObject({ type: 'toolCall', id: 'partial', name: 'pay' })
      if (recorded === undefined || recorded.type !== 'toolCall')
        throw new Error('Expected partial call')
      expect(recorded.arguments).not.toEqual(input)
    }),
)
