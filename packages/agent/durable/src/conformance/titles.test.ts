import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { isToolUIPart, tool } from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { attachRun, history } from '../main.ts'
import { call, consume, context, host } from './fixtures/host.ts'

// AI SDK process-ui-message-stream.test.ts:7599/7707/7717/7772 carries titles through result states.
it.each([false, true])(
  'keeps a static title through a failed=%s result and history',
  async (failed) => {
    const fixture = await host(
      {
        titled: tool({
          title: 'Invoice lookup',
          inputSchema: z.object({}),
          execute: async () => {
            if (failed) throw new Error('Lookup failed')
            return 'Located'
          },
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('titled', {}, 'title'), fauxAssistantMessage('Done.')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Locate' })
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    const part = chat.lastMessage.parts.find(isToolUIPart)
    expect(part).toMatchObject({
      type: 'tool-titled',
      title: 'Invoice lookup',
      state: failed ? 'output-error' : 'output-available',
    })
    await opened.root.waitForIdle(context)
    const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const assistant = saved.messages.at(-1)
    if (assistant === undefined) throw new Error('Expected stored assistant')
    expect(assistant.parts.find(isToolUIPart)).toEqual(part)
  },
)

// A held invocation must show its definition's title on a fresh SDK reconnect, before any output exists.
it('keeps an answer tool title on reconnect', async () => {
  const fixture = await host(
    { titled: tool({ title: 'Choose account', inputSchema: z.object({}) }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('titled', {}, 'title')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Choose' })
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status === 'idle') throw new Error('Expected held run')
  const result = await consume(attached.stream)
  expect(result.message.parts.find(isToolUIPart)).toMatchObject({
    title: 'Choose account',
    state: 'input-available',
  })
})
