import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  dynamicTool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { attachRun, history, waiting } from '../main.ts'
import { call, consume, context, host, signal } from './fixtures/host.ts'

// AI SDK chat.test.ts:2988–3192 and process-ui-message-stream.test.ts:6343–6609 retain dynamic identity.
it('answers a dynamic tool through stock Chat and keeps identity on reconnect and history', async () => {
  const fixture = await host(
    {
      ask: dynamicTool({
        title: 'Choose account',
        inputSchema: z.object({ question: z.string() }),
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which?' }, 'ask'),
    fauxAssistantMessage('Answered.'),
  ])
  const finished = signal()
  const chat = new PlainChat({
    transport: opened.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => {
      if (opened.faux.state.callCount === 2) finished.resolve()
    },
    onError: (error) => finished.reject(error),
  })
  await chat.sendMessage({ text: 'Ask' })
  if (chat.lastMessage === undefined) throw new Error('Expected assistant')
  expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
    type: 'dynamic-tool',
    toolName: 'ask',
    title: 'Choose account',
    state: 'input-available',
  })
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status === 'idle') throw new Error('Expected held run')
  expect((await consume(attached.stream)).message.parts.find(isToolUIPart)).toEqual(
    chat.lastMessage.parts.find(isToolUIPart),
  )
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })
  await finished.promise
  expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
    type: 'dynamic-tool',
    state: 'output-available',
    output: 'Savings',
  })
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  await opened.root.waitForIdle(context)
  const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  const assistant = saved.messages.at(-1)
  if (assistant === undefined) throw new Error('Expected stored assistant')
  expect(assistant.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
})

// Upstream preliminary-result cases cover dynamic generators with and without approval; only the final yield survives.
it.each([true, false])('keeps dynamic generator identity after approved=%s', async (approved) => {
  let executions = 0
  const fixture = await host(
    {
      progress: dynamicTool({
        title: 'Invoice payment',
        inputSchema: z.object({}),
        execute: async function* () {
          executions++
          yield { status: 'loading' }
          yield { status: 'success' }
        },
      }),
    },
    { approval: { progress: true } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('progress', {}, 'progress'), fauxAssistantMessage('Settled.')])
  let finished = signal()
  const chat = new PlainChat({
    transport: opened.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => finished.resolve(),
    onError: (error) => finished.reject(error),
  })
  await chat.sendMessage({ text: 'Pay' })
  if (chat.lastMessage === undefined) throw new Error('Expected assistant')
  const held = chat.lastMessage.parts.find(isToolUIPart)
  if (held === undefined || held.state !== 'approval-requested')
    throw new Error('Expected approval')
  expect(held).toMatchObject({ type: 'dynamic-tool', title: 'Invoice payment' })
  finished = signal()
  await chat.addToolApprovalResponse({ id: held.approval.id, approved })
  await finished.promise
  expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
    type: 'dynamic-tool',
    title: 'Invoice payment',
    state: approved ? 'output-available' : 'output-denied',
  })
  if (approved)
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      output: { status: 'success' },
    })
  expect(executions).toBe(approved ? 1 : 0)
  await opened.root.waitForIdle(context)
  const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  const assistant = saved.messages.at(-1)
  if (assistant === undefined) throw new Error('Expected stored assistant')
  expect(assistant.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
})
