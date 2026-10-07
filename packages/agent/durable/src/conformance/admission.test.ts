import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, onTestFinished } from 'vitest'
import {
  DefaultChatTransport,
  tool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import * as NodeEvents from 'node:events'
import type { Harness } from '@earendil-works/pi-durable'
import { requestBudget } from '../fixtures/budget.mjs'
import { PlainChat } from '../fixtures/chat.ts'
import {
  abort,
  decide,
  followRun,
  decodeTurn,
  respond,
  streamRun,
  history,
  TurnWithdrawn,
  TurnStranded,
  TurnWaiting,
  TurnBusy,
  LimitInvalid,
  TurnRegenerate,
  RunMissing,
} from '../main.ts'
import { call, consume, context, host, shop, signal, texts, hold } from './fixtures/host.ts'

/** A lost HTTP response can be retried with the same user identity after its run has settled. */
it.each(['done', 'aborted', 'failed', 'active'] as const)(
  'finishes a repeated user POST for a %s run without another model invocation',
  async (state) => {
    const fixture = await shop()
    const opened = await fixture.open()
    const response =
      state === 'failed'
        ? fauxAssistantMessage('Failed partial', {
            stopReason: 'error',
            errorMessage: 'invalid model request',
          })
        : fauxAssistantMessage('Done.')
    opened.faux.setResponses(
      state === 'active' || state === 'aborted' ? [call('pay', { amount: 1 }, 'held')] : [response],
    )
    const first = new PlainChat({ transport: opened.transport })
    await first.sendMessage({ text: 'First' })
    if (state === 'aborted') await abort(opened.harness, opened.root.id, context)
    if (state !== 'active') await opened.root.waitForIdle(context)
    const user = first.messages[0]
    if (user === undefined || user.role !== 'user') throw new Error('Expected user input')
    const finished = signal()
    const retried = new PlainChat({
      transport: opened.transport,
      onFinish: () => finished.resolve(),
    })
    retried.messages = [user]
    await retried.sendMessage()
    await finished.promise
    expect(retried.status).toBe(state === 'failed' ? 'error' : 'ready')
    expect(opened.faux.state.callCount).toBe(1)
    if (retried.lastMessage === undefined || first.lastMessage === undefined)
      throw new Error('Expected messages')
    expect(retried.lastMessage.id).toBe(first.lastMessage.id)
    if (state === 'done') expect(texts(retried.lastMessage)).toEqual(['Done.'])
    if (state === 'active') expect(retried.lastMessage.parts).toEqual(first.lastMessage.parts)
    if (state === 'aborted')
      expect(retried.lastMessage.parts).toContainEqual(
        expect.objectContaining({ toolCallId: 'held', state: 'output-error' }),
      )
  },
)

/** Pi's transcript is append-only; stock SDK regeneration must be an explicit typed refusal. */
it('refuses stock Chat.regenerate with 400 instead of reopening the same input', async () => {
  const opened = await (await shop()).open()
  opened.faux.setResponses([fauxAssistantMessage('Once')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'First' })
  await chat.regenerate()
  expect(chat.status).toBe('error')
  expect(chat.error).toBeInstanceOf(Error)
  if (chat.error === undefined) throw new Error('Expected regeneration refusal')
  expect(chat.error.message).toBe('Regeneration is not supported')
  expect(opened.faux.state.callCount).toBe(1)
})

/** A committed queued receipt, rather than a timer, proves admission before the host aborts. */
function queued(harness: Harness, requestId: string) {
  const admitted = signal()
  const unsubscribe = harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (change) =>
          change.type === 'submission' &&
          change.value.requestId === requestId &&
          change.value.status === 'queued',
      )
    )
      admitted.resolve()
  })
  onTestFinished(unsubscribe)
  return admitted.promise
}

/** Abort releases this real SDK invocation through its signal; cleanup also releases a failed test. */
async function working() {
  const entered = signal()
  const release = signal()
  onTestFinished(() => release.resolve())
  const fixture = await host(
    {
      work: tool({
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          entered.resolve()
          if (options.abortSignal === undefined)
            throw new Error('Expected tool cancellation signal')
          await Promise.race([
            release.promise,
            NodeEvents.EventEmitter.once(options.abortSignal, 'abort'),
          ])
          return 'worked'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('work', {}, 'work'),
    fauxAssistantMessage('First finished.'),
    fauxAssistantMessage('Second finished.'),
  ])
  const first = new PlainChat({ transport: opened.transport })
  const sending = first.sendMessage({ text: 'First' })
  await entered.promise
  return { ...opened, first, sending, release }
}

/** R10-1: neither a follow-up nor a steer withdrawn before placement has an assistant to acknowledge. */
it.each(['followUp', 'steer'] as const)(
  'ends a withdrawn %s POST and refuses its retry',
  async (whenBusy) => {
    const opened = await working()
    const admitted = queued(opened.harness, 'withdrawn')
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) =>
        respond(
          opened.harness,
          opened.root.id,
          { request: new Request(url, init), options: { whenBusy } },
          context,
        ),
    })
    const chat = new PlainChat({ transport, generateId: () => 'withdrawn' })
    const posting = chat.sendMessage({ text: 'Withdrawn person input' })
    await admitted
    await abort(opened.harness, opened.root.id, context)
    await posting
    await opened.sending
    expect(chat.status).toBe('error')
    if (chat.error === undefined) throw new Error('Expected admission refusal')
    expect(chat.error.message).toBe(new TurnWithdrawn({ messageId: 'withdrawn' }).message)
    const input = {
      conversationId: opened.root.id,
      content: 'Withdrawn person input',
      requestId: 'withdrawn',
    }
    await expect(streamRun(opened.harness, input, context)).rejects.toBeInstanceOf(TurnWithdrawn)
    await expect(
      followRun(opened.harness, opened.root.id, 'withdrawn', context),
    ).rejects.toBeInstanceOf(TurnWithdrawn)
    const retry = await respond(
      opened.harness,
      opened.root.id,
      new Request('http://durable.test/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'user', id: 'withdrawn', parts: [{ type: 'text', text: input.content }] },
          ],
        }),
      }),
      context,
    )
    expect(retry.status).toBe(409)
    const stored = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(stored.messages.flatMap(texts)).not.toContain(input.content)
  },
)

/** Reject is Pi's no-write busy admission, surfaced before any UI stream exists. */
it('refuses a busy reject turn immediately without admitting it', async () => {
  const opened = await working()
  await expect(
    streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'No queue',
        requestId: 'rejected',
        options: { whenBusy: 'reject' },
      },
      context,
    ),
  ).rejects.toBeInstanceOf(TurnBusy)
  await expect(
    followRun(opened.harness, opened.root.id, 'rejected', context),
  ).rejects.toBeInstanceOf(RunMissing)
  const chat = new PlainChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) =>
        respond(
          opened.harness,
          opened.root.id,
          { request: new Request(url, init), options: { whenBusy: 'reject' } },
          context,
        ),
    }),
  })
  await chat.sendMessage({ text: 'No queue either' })
  expect(chat.status).toBe('error')
  if (chat.error === undefined) throw new Error('Expected admission refusal')
  expect(chat.error.message).toBe(new TurnBusy({ conversationId: opened.root.id }).message)
  await abort(opened.harness, opened.root.id, context)
  await opened.sending
})

/** The observer acquires its own receipt and follows only the queued request's eventual run. */
it('follows a queued host input when it is placed, with two independent readers', async () => {
  const opened = await working()
  const handle = await opened.root.submit(
    { type: 'input', content: 'Second', requestId: 'host-second' },
    context,
  )
  expect((await handle.status(context)).status).toBe('queued')
  const one = followRun(opened.harness, opened.root.id, 'host-second', context)
  const two = followRun(opened.harness, opened.root.id, 'host-second', context)
  opened.release.resolve()
  await opened.sending
  const a = await consume(await one)
  const b = await consume(await two)
  expect(a.message).toEqual(b.message)
  expect(texts(a.message)).toEqual(['Second finished.'])
  if (opened.first.lastMessage === undefined) throw new Error('Expected first assistant message')
  expect(a.message.id).not.toBe(opened.first.lastMessage.id)
  const stored = await consume(
    await followRun(opened.harness, opened.root.id, 'host-second', context),
  )
  expect(stored.message).toEqual(a.message)
})

/** Stored completed/aborted responses remain reacquirable even while a successor run waits. */
it.each(['completed', 'aborted'] as const)(
  'follows the stored %s run rather than a newer active run',
  async (state) => {
    const opened = await (await shop()).open()
    opened.faux.setResponses([
      state === 'completed'
        ? fauxAssistantMessage('Completed.')
        : call('pay', { amount: 1 }, 'old'),
    ])
    await opened.root.submit({ type: 'input', content: 'Old', requestId: 'host-old' }, context)
    const old = await consume(await followRun(opened.harness, opened.root.id, 'host-old', context))
    if (state === 'aborted') await abort(opened.harness, opened.root.id, context)
    else await opened.root.waitForIdle(context)
    opened.faux.setResponses([call('pay', { amount: 2 }, 'new')])
    const next = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'New', requestId: 'host-new' },
        context,
      ),
    )
    const stored = await consume(
      await followRun(opened.harness, opened.root.id, 'host-old', context),
    )
    expect(stored.message.id).toBe(old.message.id)
    expect(stored.message.id).not.toBe(next.message.id)
    if (state === 'completed') expect(stored.message).toEqual(old.message)
    else
      expect(stored.message.parts).toContainEqual(
        expect.objectContaining({ toolCallId: 'old', state: 'output-error' }),
      )
    expect(
      stored.message.parts.some((part) => 'toolCallId' in part && part.toolCallId === 'new'),
    ).toBe(false)
  },
)

/** Non-TypeScript hosts must receive the same tagged refusal, preserving the offending wire value. */
it.each(['5', null, {}])(
  'tags a non-numeric host part budget %j without reading or submitting',
  async (value) => {
    const opened = await (await shop()).open()
    const request = requestBudget(
      opened.harness,
      { conversationId: opened.root.id, value },
      context,
    )
    await expect(request).rejects.toBeInstanceOf(LimitInvalid)
    await expect(request).rejects.toMatchObject({ value })
    expect(opened.faux.state.callCount).toBe(0)
    expect((await opened.root.entries({}, 10, undefined, context)).items).toEqual([])
  },
)

/** Regeneration keeps its own tag through object and JSON-string codecs, never a text comparison. */
it('rejects regeneration with its own class through both body decoder and Request ingress', async () => {
  const opened = await (await shop()).open()
  const body = {
    trigger: 'regenerate-message',
    messages: [{ role: 'user', id: 'regenerate', parts: [{ type: 'text', text: 'Again' }] }],
  }
  await expect(decodeTurn(body)).rejects.toBeInstanceOf(TurnRegenerate)
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', { method: 'POST', body: JSON.stringify(body) }),
    context,
  )
  expect(response.status).toBe(400)
  expect(await response.text()).toBe(new TurnRegenerate({}).message)
  expect(opened.faux.state.callCount).toBe(0)
})

/** A final boundary places a queued successor under the predecessor generation task (Pi
 * generation.js:408–421). Task attribution is not a run boundary; replay must stop before B. */
it.each(['running', 'ended'] as const)(
  'bounds a completed predecessor while its queued successor is %s',
  async (state) => {
    const opened = await (await shop()).open()
    const entered = signal()
    const release = signal()
    onTestFinished(() => release.resolve())
    opened.faux.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('Recovered initial.')
      },
      call('pay', { amount: 2 }, 'successor'),
      fauxAssistantMessage('Queued final.'),
    ])
    await opened.root.submit(
      { type: 'input', content: 'First', requestId: 'bounded-first' },
      context,
    )
    await entered.promise
    const successorInput = await opened.root.submit(
      { type: 'input', content: 'Second', requestId: 'bounded-second' },
      context,
    )
    expect((await successorInput.status(context)).status).toBe('queued')
    const original = consume(
      await followRun(opened.harness, opened.root.id, 'bounded-first', context),
    )
    release.resolve()
    const first = await original
    await consume(await followRun(opened.harness, opened.root.id, 'bounded-second', context))
    if (state === 'ended') {
      await decide(
        opened.harness,
        opened.root.id,
        { holdId: await hold(opened.harness, opened.root.id, 'successor'), approved: true },
        context,
      )
      await opened.root.waitForIdle(context)
    }
    const replayed = await consume(
      await followRun(opened.harness, opened.root.id, 'bounded-first', context),
    )
    expect(texts(replayed.message)).toEqual(['Recovered initial.'])
    expect(replayed.message).toEqual(first.message)
    expect(replayed.chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: first.message.metadata,
    })
  },
)

/** A failed predecessor leaves queued inputs in Pi's inbox. Library POSTs withdraw only their
 * own input and answer 409; retries observe the same durable withdrawal instead of hanging. */
it.each(['followUp', 'steer'] as const)(
  'withdraws a %s POST stranded by model failure',
  async (whenBusy) => {
    const entered = signal()
    const release = signal()
    onTestFinished(() => release.resolve())
    const opened = await (await host({}, {}, { retry: { enabled: false, baseDelayMs: 0 } })).open()
    opened.faux.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('partial', {
          stopReason: 'error',
          errorMessage: 'invalid model request',
        })
      },
    ])
    const first = new PlainChat({ transport: opened.transport })
    const sending = first.sendMessage({ text: 'Predecessor' })
    await entered.promise
    const admitted = queued(opened.harness, 'stranded-post')
    const chat = new PlainChat({
      generateId: () => 'stranded-post',
      transport: new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: async (url, init) =>
          respond(
            opened.harness,
            opened.root.id,
            { request: new Request(url, init), options: { whenBusy } },
            context,
          ),
      }),
    })
    const posting = chat.sendMessage({ text: 'Not placed' })
    await admitted
    release.resolve()
    await sending
    await posting
    expect(chat.status).toBe('error')
    expect(chat.error === undefined ? undefined : chat.error.message).toBe(
      new TurnWithdrawn({ messageId: 'stranded-post' }).message,
    )
    await expect(
      streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'Not placed',
          requestId: 'stranded-post',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(TurnWithdrawn)
    expect(
      (await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages.flatMap(
        texts,
      ),
    ).not.toContain('Not placed')
  },
)

/** A host-owned input remains untouched on both the run-end event and a subsequent idle watch.
 * A later submission places it, after which following the same id succeeds. */
it('reports a stranded host input without withdrawing it, then follows its placed run', async () => {
  const opened = await working()
  opened.faux.setResponses([
    fauxAssistantMessage('partial', {
      stopReason: 'error',
      errorMessage: 'invalid model request',
    }),
  ])
  const submission = await opened.root.submit(
    { type: 'input', content: 'Host queued', requestId: 'host-stranded' },
    context,
  )
  const followed = followRun(opened.harness, opened.root.id, 'host-stranded', context)
  const rejected = expect(followed).rejects.toBeInstanceOf(TurnStranded)
  opened.release.resolve()
  await opened.sending
  await rejected
  await opened.root.waitForIdle(context)
  expect((await submission.status(context)).status).toBe('queued')
  await expect(
    followRun(opened.harness, opened.root.id, 'host-stranded', context),
  ).rejects.toBeInstanceOf(TurnStranded)
  opened.faux.setResponses([
    fauxAssistantMessage('Queued answer.'),
    fauxAssistantMessage('Next answer.'),
  ])
  await opened.root.submit({ type: 'input', content: 'Unstick', requestId: 'unstick' }, context)
  const result = await consume(
    await followRun(opened.harness, opened.root.id, 'host-stranded', context),
  )
  expect(texts(result.message)).toEqual(['Queued answer.'])
})

/** A new message cannot be answered while this Chat's predecessor waits for a person.
 * Both installed stock predicates (ui/last-assistant-message-is-complete-*.ts) require a last
 * assistant message: remove the refused user before approving, then the stock flow works. */
it.each(['followUp', 'steer', 'reject'] as const)(
  'refuses new %s input while parked without queuing it',
  async (whenBusy) => {
    const fixture = await shop()
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', { amount: 3 }, 'pay'), fauxAssistantMessage('Paid.')])
    const finished = signal()
    const chat = new PlainChat({
      onFinish: () => {
        if (fixture.paid.length > 0) finished.resolve()
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      transport: new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: async (url, init) =>
          respond(
            opened.harness,
            opened.root.id,
            { request: new Request(url, init), options: { whenBusy } },
            context,
          ),
      }),
    })
    await chat.sendMessage({ text: 'Pay' })
    const held = chat.lastMessage
    if (held === undefined) throw new Error('Expected held assistant')
    const part = held.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected approval')
    await chat.sendMessage({ text: 'Another message' })
    expect(chat.status).toBe('error')
    if (chat.error === undefined) throw new Error('Expected waiting refusal')
    expect(chat.error.message).toBe(new TurnWaiting({ conversationId: opened.root.id }).message)
    const refused = chat.lastMessage
    if (refused === undefined) throw new Error('Expected refused user message')
    await expect(
      followRun(opened.harness, opened.root.id, refused.id, context),
    ).rejects.toBeInstanceOf(RunMissing)
    expect(lastAssistantMessageIsCompleteWithApprovalResponses({ messages: chat.messages })).toBe(
      false,
    )
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages: chat.messages })).toBe(false)
    chat.messages = chat.messages.slice(0, -1)
    chat.clearError()
    await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
    await finished.promise
    expect(chat.status).toBe('ready')
    expect(fixture.paid).toEqual([3])
    if (chat.lastMessage === undefined) throw new Error('Expected final message')
    expect(texts(chat.lastMessage)).toEqual(['Paid.'])
  },
)

/** A queued POST is withdrawn when the predecessor parks, using the same waiting rule as
 * admission. Host-owned receipts may deliberately wait there and are not withdrawn. */
it('withdraws a queued POST when its predecessor parks, but keeps a host follower', async () => {
  const entered = signal()
  const release = signal()
  onTestFinished(() => release.resolve())
  const fixture = await shop()
  const held = await fixture.open()
  held.faux.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return call('pay', { amount: 4 }, 'held')
    },
    fauxAssistantMessage('Paid.'),
    fauxAssistantMessage('Host answered.'),
  ])
  const first = new PlainChat({ transport: held.transport })
  const sending = first.sendMessage({ text: 'First' })
  await entered.promise
  const admitted = queued(held.harness, 'queued-before-hold')
  const next = new PlainChat({ transport: held.transport, generateId: () => 'queued-before-hold' })
  const posting = next.sendMessage({ text: 'Queued POST' })
  await admitted
  const hostInput = await held.root.submit(
    { type: 'input', content: 'Host input', requestId: 'host-behind-hold' },
    context,
  )
  const following = followRun(held.harness, held.root.id, 'host-behind-hold', context)
  release.resolve()
  await sending
  await posting
  expect(next.status).toBe('error')
  if (next.error === undefined) throw new Error('Expected parked refusal')
  expect(next.error.message).toBe(new TurnWaiting({ conversationId: held.root.id }).message)
  expect((await hostInput.status(context)).status).toBe('queued')
  await decide(
    held.harness,
    held.root.id,
    { holdId: await hold(held.harness, held.root.id, 'held'), approved: true },
    context,
  )
  expect(texts((await consume(await following)).message)).toEqual(['Host answered.'])
})
