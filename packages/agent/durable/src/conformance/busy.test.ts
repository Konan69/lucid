import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { InboxDoc } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { DefaultChatTransport, tool, type UIMessage } from 'ai'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { respond } from '../main.ts'
import { call, context, host, modelText, signal, texts } from './fixtures/host.ts'

/** Pi inbox.js:44 places steers at the post-tools boundary, while follow-ups wait for final.
 * A real pending SDK tool leaves time for a second Chat to POST; durable queue publication releases
 * the first tool, so these three host choices require no scheduler or token-rate timing assumption. */
for (const whenBusy of ['steer', 'followUp', 'default'] as const)
  it.live(`applies host ${whenBusy} policy through Chat and the native input boundary`, () =>
    Effect.promise(async () => {
      const entered = signal()
      const released = signal()
      const admitted = signal()
      onTestFinished(() => released.resolve())
      const fixture = await host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: async () => {
              entered.resolve()
              await released.promise
              return 'worked'
            },
          }),
        },
        {},
      )
      const opened = await fixture.open()
      let afterTools = ''
      opened.faux.setResponses([
        call('work', {}, 'work'),
        (transcript) => {
          afterTools = modelText(transcript.messages)
          return fauxAssistantMessage('First finished.')
        },
        fauxAssistantMessage('Second finished.'),
      ])
      const first = new PlainChat({ transport: opened.transport })
      const sending = first.sendMessage({ text: 'First input' })
      await entered.promise
      const unsubscribe = opened.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === 'submission' &&
              change.value.requestId === 'busy-second' &&
              change.value.status === 'queued',
          )
        )
          admitted.resolve()
      })
      onTestFinished(unsubscribe)
      const second = new PlainChat({
        generateId: () => 'busy-second',
        transport: new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: async (url, init) => {
            const request = new Request(url, init)
            const response = await (whenBusy === 'default'
              ? respond(opened.harness, opened.root.id, request, context)
              : respond(
                  opened.harness,
                  opened.root.id,
                  { request, options: { whenBusy } },
                  context,
                ))
            return response
          },
        }),
      })
      const posting = second.sendMessage({ text: 'Second input' })
      await admitted.promise
      const inbox = await opened.harness.snapshot(InboxDoc, opened.root.id, context)
      if (inbox === undefined) throw new Error('Expected queued input document')
      const item = inbox.items.find((candidate) => candidate.mode !== 'write')
      if (item === undefined) throw new Error('Expected queued user input')
      expect(item.mode).toBe(whenBusy === 'default' ? 'followUp' : whenBusy)
      released.resolve()
      await Promise.all([sending, posting])
      expect(first.status).toBe('ready')
      expect(second.status).toBe('ready')
      if (first.lastMessage === undefined || second.lastMessage === undefined)
        throw new Error('Expected both assistant outcomes')
      expect(texts(first.lastMessage)).toEqual(['First finished.'])
      expect(first.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      expect(second.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      if (whenBusy === 'steer') {
        expect(afterTools).toContain('Second input')
        expect(second.lastMessage).toEqual(first.lastMessage)
        expect(opened.faux.state.callCount).toBe(2)
      } else {
        expect(afterTools).not.toContain('Second input')
        expect(texts(second.lastMessage)).toEqual(['Second finished.'])
        expect(second.lastMessage.id).not.toBe(first.lastMessage.id)
        expect(opened.faux.state.callCount).toBe(3)
      }
    }),
  )
