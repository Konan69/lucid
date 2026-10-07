import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { tool, type UIMessage } from 'ai'
import { z } from 'zod'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  AssistantEntry,
  UserEntry,
  GenerationTask,
  defineExtension,
  hook,
} from '@earendil-works/pi-durable'
import { PlainChat } from '../fixtures/chat.ts'
import { continueRun, followRun, history, RunMissing } from '../main.ts'
import { call, consume, context, host, signal } from './fixtures/host.ts'

/** IDs must agree as lists are reloaded, not merely have the right prefix. */
function savedAssistant(messages: readonly UIMessage[]) {
  const message = messages.findLast((item) => item.role === 'assistant')
  if (message === undefined) throw new Error('Expected stored assistant')
  return message
}

/** The cursor lies between two consecutive user entries; assistant identity must come from
 * its own first assistant, never the user's position or which page began the stretch. */
it.live('keeps generation identity when a page boundary falls inside a user block', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {})
    const opened = await fixture.open()
    await opened.root.commit(
      (tx) =>
        tx.appendEntry(UserEntry, opened.root.id, {
          model: [{ role: 'user', content: 'Earlier', timestamp: 1 }],
        }),
      context,
    )
    opened.faux.setResponses([fauxAssistantMessage('Answer.')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Current' })
    const page = await history(opened.harness, opened.root.id, { limit: 2 }, context)
    if (chat.lastMessage === undefined || page.next === undefined) throw new Error('Expected page')
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(savedAssistant(page.messages).id).toBe(chat.lastMessage.id)
    const previous = await history(
      opened.harness,
      opened.root.id,
      { limit: 2, before: page.next },
      context,
    )
    expect(previous.messages.map((message) => message.role)).toEqual(['user'])
    const whole = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(savedAssistant(whole.messages).id).toBe(chat.lastMessage.id)
  }),
)

/** A queued successor gets its own generation id, shared by live Chat and stored followRun.
 * Gates hold the predecessor at the provider boundary; no token-rate timer admits the successor. */
it.live('keeps queued live, stored followRun and paged history assistant identities equal', () =>
  Effect.promise(async () => {
    const entered = signal()
    const release = signal()
    const secondEntered = signal()
    const secondRelease = signal()
    onTestFinished(() => release.resolve())
    onTestFinished(() => secondRelease.resolve())
    const fixture = await host({}, {})
    const opened = await fixture.open()
    opened.faux.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('First.')
      },
      async () => {
        secondEntered.resolve()
        await secondRelease.promise
        return fauxAssistantMessage('Second.')
      },
    ])
    const first = new PlainChat({ transport: opened.transport })
    const firstTurn = first.sendMessage({ text: 'First' })
    await entered.promise
    const input = await opened.root.submit(
      { type: 'input', content: 'Second', requestId: 'queued' },
      context,
    )
    expect((await input.status(context)).status).toBe('queued')
    const second = new PlainChat({ transport: opened.transport })
    const secondTurn = second.sendMessage({
      id: 'queued',
      role: 'user',
      parts: [{ type: 'text', text: 'Second' }],
    })
    const live = followRun(opened.harness, opened.root.id, 'queued', context)
    release.resolve()
    await firstTurn
    await secondEntered.promise
    const reading = consume(await live)
    secondRelease.resolve()
    const observed = await reading
    await secondTurn
    const stored = await consume(await followRun(opened.harness, opened.root.id, 'queued', context))
    const page = await history(opened.harness, opened.root.id, { limit: 1 }, context)
    if (second.lastMessage === undefined) throw new Error('Expected live assistant')
    expect(second.status).toBe('ready')
    expect(observed.message.id).toBe(second.lastMessage.id)
    expect(stored.message.id).toBe(second.lastMessage.id)
    expect(savedAssistant(page.messages).id).toBe(second.lastMessage.id)
    const complete = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    if (first.lastMessage === undefined) throw new Error('Expected first assistant')
    expect(
      complete.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.id),
    ).toEqual([first.lastMessage.id, second.lastMessage.id])
    second.messages = complete.messages
    expect(second.messages.filter((message) => message.id === stored.message.id)).toHaveLength(1)
  }),
)

/** Steers and hook continuations extend the live run but create separate stored stretches.
 * Their first stretch shares the live id; a later generation cannot rename it or reuse it. */
it.live.each(['steer', 'continuation'] as const)(
  'keeps the first %s stretch on the live generation id',
  (mode) =>
    Effect.promise(async () => {
      const entered = signal()
      const release = signal()
      onTestFinished(() => release.resolve())
      const fixture = await host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: async () => {
              entered.resolve()
              await release.promise
              return 'Worked.'
            },
          }),
        },
        {},
      )
      const opened = await fixture.open([
        defineExtension({
          name: 'continued',
          hooks: [
            hook(GenerationTask, {
              onYield: (message) =>
                mode === 'continuation' &&
                message.content.some((part) => part.type === 'text' && part.text === 'First.')
                  ? { continue: 'Continue' }
                  : undefined,
            }),
          ],
        }),
      ])
      opened.faux.setResponses([
        mode === 'steer' ? call('work', {}, 'work') : fauxAssistantMessage('First.'),
        fauxAssistantMessage('Final.'),
      ])
      const chat = new PlainChat({ transport: opened.transport })
      const sending = chat.sendMessage({ text: 'Start' })
      if (mode === 'steer') {
        await entered.promise
        await opened.root.submit(
          { type: 'input', content: 'Steer', requestId: 'steer', whenBusy: 'steer' },
          context,
        )
        release.resolve()
      }
      await sending
      const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      const assistants = saved.messages.filter((message) => message.role === 'assistant')
      if (chat.lastMessage === undefined || assistants[0] === undefined)
        throw new Error('Expected assistants')
      expect(assistants).toHaveLength(2)
      expect(assistants[0].id).toBe(chat.lastMessage.id)
      expect(new Set(saved.messages.map((message) => message.id)).size).toBe(saved.messages.length)
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    }),
)

/** A closed queued run has attribution, but T-1 is not its receipt. Refuse that client resume
 * instead of searching adjacent ids; host-admitted followRun still supplies its stored outcome. */
it.live('refuses a closed queued generation when its one receipt candidate does not verify', () =>
  Effect.promise(async () => {
    const entered = signal()
    const release = signal()
    onTestFinished(() => release.resolve())
    const fixture = await host(
      { work: tool({ inputSchema: z.object({}), execute: async () => 'Worked.' }) },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('First.')
      },
      call('work', {}, 'queued-call'),
      fauxAssistantMessage('Done.'),
    ])
    await opened.root.submit({ type: 'input', content: 'First', requestId: 'first' }, context)
    await entered.promise
    await opened.root.submit({ type: 'input', content: 'Queued', requestId: 'queued' }, context)
    release.resolve()
    await opened.root.waitForIdle(context)
    const result = await consume(await followRun(opened.harness, opened.root.id, 'queued', context))
    expect(result.message.id).toMatch(/^gen:/u)
    await expect(
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: result.message.id, known: new Set(['queued-call']) },
        context,
      ),
    ).rejects.toBeInstanceOf(RunMissing)
    await expect(
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: 'run:1', known: new Set(['queued-call']) },
        context,
      ),
    ).rejects.toBeInstanceOf(RunMissing)
  }),
)

/** generation.failNoModel writes no assistant (generation.js:235–244). Stored replay has no
 * task provenance to claim: the SDK honestly sees an empty input:<entry> assistant, and gen resume
 * cannot verify it. No task result or neighboring receipt is consulted. */
it.live(
  'names an empty failed stored run from its input entry and refuses its generation resume',
  () =>
    Effect.promise(async () => {
      const fixture = await host({}, {})
      const opened = await fixture.open()
      await opened.root.configure({ model: { provider: 'missing', modelId: 'missing' } }, context)
      const receipt = await opened.root.submit(
        { type: 'input', content: 'Go', requestId: 'empty' },
        context,
      )
      await opened.root.waitForIdle(context)
      const status = await receipt.status(context)
      if (status.type !== 'input' || status.entry === undefined)
        throw new Error('Expected placed input')
      expect(status).toMatchObject({ status: 'unanswered', reason: 'no_model' })
      const entries = await opened.root.entries({}, 100, undefined, context)
      expect(entries.items.filter((entry) => entry.kind === 'pi.assistant')).toEqual([])
      const stored = await consume(
        await followRun(opened.harness, opened.root.id, 'empty', context),
      )
      expect(stored.message.id).toBe(`input:${status.entry}`)
      expect(stored.message.parts).toEqual([])
      await expect(
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: `gen:${receipt.id + 1}`, known: new Set() },
          context,
        ),
      ).rejects.toBeInstanceOf(RunMissing)
    }),
)

/** A host-written assistant has no task; its tagged Written branch preserves entry identity. */
it.live('keeps entry identity for a host-written assistant without generation attribution', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {})
    const opened = await fixture.open()
    const entry = await opened.root.commit(
      (tx) =>
        tx.appendEntry(AssistantEntry, opened.root.id, {
          model: [fauxAssistantMessage('Host-written.')],
        }),
      context,
    )
    expect(entry.byTaskId).toBeUndefined()
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(savedAssistant(page.messages).id).toBe(`entry:${entry.id}`)
  }),
)
