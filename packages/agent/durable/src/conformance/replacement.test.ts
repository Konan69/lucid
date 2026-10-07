import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Deferred } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { history } from '../main.ts'
import { context, host, texts } from './fixtures/host.ts'

/** Provider replacements are authoritative, including changed prefixes and removed whole blocks. */
it.live.each([
  { name: 'equal length', before: ['abc'], after: 'abd' },
  { name: 'longer changed prefix', before: ['abc'], after: 'xbcd' },
  { name: 'removed block', before: ['keep', 'dropped'], after: 'keep' },
])('rebuilds a $name replacement in real Chat to match history', ({ before, after }) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const appeared = yield* Deferred.make<void>()
    const fixture = yield* host(
      {},
      {},
      { progress: { partialIntervalMs: 1 } },
      {
        replacedContent: before.map(fauxText),
        onFrame: (event, abortSignal) =>
          event.type === 'start' ? waitForFrame(Deferred.await(release), abortSignal) : Effect.void,
      },
    )
    const opened = yield* fixture.open()
    // Release provider gates before the scoped harness waits for its running work.
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    opened.faux.setResponses([fauxAssistantMessage(after)])
    const chat = new PlainChat({
      transport: opened.transport,
      onMessage: (message) => {
        if (message.role === 'assistant' && texts(message).join('') === before.join(''))
          Deferred.doneUnsafe(appeared, Effect.void)
      },
    })
    const sent = chat.sendMessage({ text: 'Replace' })
    yield* Deferred.await(appeared)
    if (chat.lastMessage === undefined) throw new Error('Expected committed client partial')
    expect(texts(chat.lastMessage)).toEqual(before)
    yield* Deferred.succeed(release, undefined)
    yield* Effect.promise(() => sent)
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected replaced assistant')
    expect(texts(chat.lastMessage)).toEqual([after])
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected history assistant')
    expect(chat.lastMessage.parts).toEqual(assistant.parts)
  }),
)
