import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { history } from '../main.ts'
import { context, host, signal, texts } from './fixtures/host.ts'

/** Provider replacements are authoritative, including changed prefixes and removed whole blocks. */
it.live.each([
  { name: 'equal length', before: ['abc'], after: 'abd' },
  { name: 'longer changed prefix', before: ['abc'], after: 'xbcd' },
  { name: 'removed block', before: ['keep', 'dropped'], after: 'keep' },
])('rebuilds a $name replacement in real Chat to match history', ({ before, after }) =>
  Effect.promise(async () => {
    const release = signal()
    const appeared = signal()
    const fixture = await host(
      {},
      {},
      { progress: { partialIntervalMs: 1 } },
      {
        replacedContent: before.map(fauxText),
        onFrame: (event, abortSignal) =>
          event.type === 'start'
            ? waitForFrame(
                Effect.promise(() => release.promise),
                abortSignal,
              )
            : Effect.void,
      },
    )
    onTestFinished(() => release.resolve())
    const opened = await fixture.open()
    opened.faux.setResponses([fauxAssistantMessage(after)])
    const chat = new PlainChat({
      transport: opened.transport,
      onMessage: (message) => {
        if (message.role === 'assistant' && texts(message).join('') === before.join(''))
          appeared.resolve()
      },
    })
    const sent = chat.sendMessage({ text: 'Replace' })
    await appeared.promise
    if (chat.lastMessage === undefined) throw new Error('Expected committed client partial')
    expect(texts(chat.lastMessage)).toEqual(before)
    release.resolve()
    await sent
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected replaced assistant')
    expect(texts(chat.lastMessage)).toEqual([after])
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected history assistant')
    expect(chat.lastMessage.parts).toEqual(assistant.parts)
  }),
)
