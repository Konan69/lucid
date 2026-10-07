import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { LiveDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { runForPi } from '../pi.ts'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, history, respond } from '../main.ts'
import { call, context, shop, signal, host } from './fixtures/host.ts'

/** Both stock predicates must be false at the same terminal boundary, including stale settlements. */
const automatic = (state: { messages: UIMessage[] }) =>
  lastAssistantMessageIsCompleteWithApprovalResponses(state) ||
  lastAssistantMessageIsCompleteWithToolCalls(state)

for (const kind of ['approval', 'output'] as const)
  it.live(`restores a closed ${kind} to durable truth without applying the stale settlement`, () =>
    Effect.promise(async () => {
      const fixture = await shop()
      const opened = await fixture.open()
      const name = kind === 'approval' ? 'pay' : 'ask'
      opened.faux.setResponses([
        kind === 'approval'
          ? call(name, { amount: 100 }, 'old')
          : call(name, { question: 'Which?' }, 'old'),
      ])
      let posts = 0
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          posts += 1
          if (posts > 2) throw new Error('Terminal message caused another automatic POST')
          return respond(opened.harness, opened.root.id, new Request(url, init), context)
        },
      })
      let done = signal()
      const chat = new PlainChat({
        transport,
        sendAutomaticallyWhen: automatic,
        onFinish: () => done.resolve(),
        onError: (error) => done.reject(error),
      })
      await chat.sendMessage({ text: 'Go' })
      const message = chat.lastMessage
      if (message === undefined) throw new Error('Expected parked message')
      const part = message.parts.find(isToolUIPart)
      if (part === undefined) throw new Error('Expected held call')
      await abort(opened.harness, opened.root.id, context)
      done = signal()
      if (kind === 'approval') {
        if (part.state !== 'approval-requested') throw new Error('Expected approval')
        await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
      } else await chat.addToolOutput({ tool: 'ask', toolCallId: 'old', output: 'savings' })
      await done.promise
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      expect(chat.status).toBe('ready')
      expect(posts).toBe(2)
      expect(Option.getOrThrow(Option.fromNullishOr(chat.lastMessage)).parts).toEqual(
        Option.getOrThrow(Option.fromNullishOr(page.messages.at(-1))).parts,
      )
      expect(fixture.paid).toEqual([])
      expect(opened.faux.state.callCount).toBe(1)
    }),
  )

/** The public receipt stores an open reason string. These persisted SQLite fixtures exercise the
 * reader for every Pi-owned input reason (generation.js:193,228,240,508; live.js:102-103 and
 * scheduler.js:645-677), without pretending to reproduce scheduler migrations or storage faults.
 * `stale` belongs only to write receipts (inbox.js:51, submissions.js:161), never an assistant run. */
it.live.each([
  'aborted',
  'model_error',
  'no_model',
  'reset',
  'faulted',
  'missing_task',
  'task_too_old',
  'migration_failed',
  'incompatible_task',
])(
  'restores a persisted unanswered %s receipt, rather than silently accepting its decision',
  (reason) =>
    Effect.promise(async () => {
      const fixture = await shop()
      const opened = await fixture.open()
      opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
      const chat = new PlainChat({ transport: opened.transport })
      await chat.sendMessage({ text: 'Go' })
      const message = chat.lastMessage
      if (message === undefined) throw new Error('Expected parked message')
      const part = message.parts.find(isToolUIPart)
      if (part === undefined || part.state !== 'approval-requested')
        throw new Error('Expected approval')
      const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context)
      const id = live === undefined || live.run === undefined ? undefined : live.run.inputs[0]
      if (id === undefined) throw new Error('Expected active input')
      const receipt = await opened.harness.submission(id, context)
      if (receipt === undefined) throw new Error('Expected input receipt')
      await opened.root.commit(
        (tx) => tx.settleSubmission(receipt.id, { status: 'unanswered', reason }),
        context,
      )
      await abort(opened.harness, opened.root.id, context)
      expect(await receipt.status(context)).toMatchObject({ status: 'unanswered', reason })
      let posts = 0
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          if (++posts > 1) throw new Error('Repeated terminal decision')
          return respond(opened.harness, opened.root.id, new Request(url, init), context)
        },
      })
      const done = signal()
      const stale = new PlainChat({
        transport,
        sendAutomaticallyWhen: automatic,
        onFinish: () => done.resolve(),
        onError: (error) => done.reject(error),
      })
      stale.messages = [message]
      await stale.addToolApprovalResponse({ id: part.approval.id, approved: true })
      await done.promise
      expect(stale.status).toBe('ready')
      expect(posts).toBe(1)
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      expect(Option.getOrThrow(Option.fromNullishOr(stale.lastMessage)).parts).toEqual(
        Option.getOrThrow(Option.fromNullishOr(page.messages.at(-1))).parts,
      )
      expect(fixture.paid).toEqual([])
    }),
)

/** The client's decoded step count is compared with the durable closed replay, never guessed.
 * A copy which lost only the final boundary gets it once; a closed copy receives start/finish only. */
it.live.each([true, false])(
  'acknowledges a closed copy with retained closing step=%s exactly once',
  (retained) =>
    Effect.promise(async () => {
      const fixture = await shop()
      const opened = await fixture.open()
      opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
      const original = new PlainChat({ transport: opened.transport })
      await original.sendMessage({ text: 'Go' })
      await abort(opened.harness, opened.root.id, context)
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      const closed = Option.getOrThrow(Option.fromNullishOr(page.messages.at(-1)))
      const old = Option.getOrThrow(Option.fromNullishOr(original.lastMessage))
      const message = {
        ...closed,
        id: old.id,
        parts: retained ? closed.parts : closed.parts.slice(0, -1),
      }
      let posts = 0
      const chat = new PlainChat({
        transport: new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: (url, init) => {
            if (++posts > 1) throw new Error('Terminal acknowledgement repeated')
            return respond(opened.harness, opened.root.id, new Request(url, init), context)
          },
        }),
        sendAutomaticallyWhen: automatic,
      })
      chat.messages = [message]
      await chat.sendMessage()
      expect(chat.status).toBe('ready')
      expect(posts).toBe(1)
      expect(Option.getOrThrow(Option.fromNullishOr(chat.lastMessage)).parts).toEqual(closed.parts)
    }),
)

/** Pi may finish directly from its last tool round (control.terminate), with the answer pointing
 * at the assistant entry before the result. Replay bounds by the next input, not that answer id. */
it.live(
  'closes a terminating tool round identically in live, history and idempotent admission',
  () =>
    Effect.promise(async () => {
      const fixture = await host({}, {})
      const opened = await fixture.open([
        defineExtension({
          name: 'stopper',
          tools: [
            defineTool({
              name: 'stop',
              description: 'Finish the run',
              parameters: Type.Object({}),
              execute: (_input, _api, callback) =>
                runForPi(
                  Effect.succeed({
                    content: [{ type: 'text' as const, text: 'Stopped.' }],
                    control: { terminate: true as const },
                  }),
                  callback.abortSignal,
                ),
            }),
          ],
        }),
      ])
      opened.faux.setResponses([call('stop', {}, 'done')])
      const chat = new PlainChat({ transport: opened.transport, sendAutomaticallyWhen: automatic })
      await chat.sendMessage({ text: 'Stop' })
      const message = Option.getOrThrow(Option.fromNullishOr(chat.lastMessage))
      expect(chat.status).toBe('ready')
      expect(message.parts.at(-1)).toEqual({ type: 'step-start' })
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      expect(Option.getOrThrow(Option.fromNullishOr(page.messages.at(-1))).parts).toEqual(
        message.parts,
      )
      const retry = new PlainChat({ transport: opened.transport, sendAutomaticallyWhen: automatic })
      retry.messages = [Option.getOrThrow(Option.fromNullishOr(chat.messages[0]))]
      await retry.sendMessage()
      expect(retry.status).toBe('ready')
      expect(Option.getOrThrow(Option.fromNullishOr(retry.lastMessage)).parts).toEqual(
        message.parts,
      )
      expect(opened.faux.state.callCount).toBe(1)
    }),
)

/** Pi's stale reason belongs to a passive write outside the active range, not a run input.
 * Its public receipt cannot authorize a resume, even when another stored run made that call id. */
it.live('refuses a stale write receipt as a run identity', () =>
  Effect.promise(async () => {
    const fixture = await shop()
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Go' })
    await abort(opened.harness, opened.root.id, context)
    const entries = await opened.root.entries({}, 100, undefined, context)
    const user = entries.items.find((entry) => entry.kind === 'pi.user')
    if (user === undefined) throw new Error('Expected input entry')
    await opened.root.reset(undefined, context)
    const receipt = await opened.root.submit(
      { type: 'write', entry: { kind: 'terminal.receipt', head: user.id } },
      context,
    )
    expect(await receipt.status(context)).toMatchObject({
      type: 'write',
      status: 'unanswered',
      reason: 'stale',
    })
    const response = await respond(
      opened.harness,
      opened.root.id,
      new Request('http://durable.test/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'assistant',
              id: `gen:${receipt.id + 1}`,
              parts: [{ type: 'tool-pay', toolCallId: 'old' }],
            },
          ],
        }),
      }),
      context,
    )
    expect(response.status).toBe(409)
  }),
)
