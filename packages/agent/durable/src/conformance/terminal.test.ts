import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { expect, it } from '@effect/vitest'
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
import { call, context, shop, host } from './fixtures/host.ts'
/** Both stock predicates must be false at the same terminal boundary, including stale settlements. */
const automatic = (state: { messages: UIMessage[] }) =>
  lastAssistantMessageIsCompleteWithApprovalResponses(state) ||
  lastAssistantMessageIsCompleteWithToolCalls(state)
for (const kind of ['approval', 'output'] as const)
  it.live(`restores a closed ${kind} to durable truth without applying the stale settlement`, () =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
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
      let done = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        transport,
        sendAutomaticallyWhen: automatic,
        onFinish: () => Deferred.doneUnsafe(done, Effect.void),
        onError: (error) =>
          Deferred.doneUnsafe(done, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Go' }))
      const message = chat.lastMessage
      if (message === undefined) throw new Error('Expected parked message')
      const part = message.parts.find(isToolUIPart)
      if (part === undefined) throw new Error('Expected held call')
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      done = yield* Deferred.make<void, FixtureFailed>()
      if (kind === 'approval') {
        if (part.state !== 'approval-requested') throw new Error('Expected approval')
        yield* Effect.promise(() =>
          Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
        )
      } else
        yield* Effect.promise(() =>
          Promise.resolve(
            chat.addToolOutput({ tool: 'ask', toolCallId: 'old', output: 'savings' }),
          ),
        )
      yield* Deferred.await(done)
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
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
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Go' }))
      const message = chat.lastMessage
      if (message === undefined) throw new Error('Expected parked message')
      const part = message.parts.find(isToolUIPart)
      if (part === undefined || part.state !== 'approval-requested')
        throw new Error('Expected approval')
      const live = yield* Effect.promise(() =>
        opened.harness.snapshot(LiveDoc, opened.root.id, context),
      )
      const id = live === undefined || live.run === undefined ? undefined : live.run.inputs[0]
      if (id === undefined) throw new Error('Expected active input')
      const receipt = yield* Effect.promise(() => opened.harness.submission(id, context))
      if (receipt === undefined) throw new Error('Expected input receipt')
      yield* Effect.promise(() =>
        opened.root.commit(
          (tx) => tx.settleSubmission(receipt.id, { status: 'unanswered', reason }),
          context,
        ),
      )
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      expect(yield* Effect.promise(() => receipt.status(context))).toMatchObject({
        status: 'unanswered',
        reason,
      })
      let posts = 0
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          if (++posts > 1) throw new Error('Repeated terminal decision')
          return respond(opened.harness, opened.root.id, new Request(url, init), context)
        },
      })
      const done = yield* Deferred.make<void, FixtureFailed>()
      const stale = new PlainChat({
        transport,
        sendAutomaticallyWhen: automatic,
        onFinish: () => Deferred.doneUnsafe(done, Effect.void),
        onError: (error) =>
          Deferred.doneUnsafe(done, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      stale.messages = [message]
      yield* Effect.promise(() =>
        Promise.resolve(stale.addToolApprovalResponse({ id: part.approval.id, approved: true })),
      )
      yield* Deferred.await(done)
      expect(stale.status).toBe('ready')
      expect(posts).toBe(1)
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
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
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
      const original = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => original.sendMessage({ text: 'Go' }))
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
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
      yield* Effect.promise(() => chat.sendMessage())
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
    Effect.gen(function* () {
      const fixture = yield* host({}, {})
      const opened = yield* fixture.open([
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
      yield* Effect.promise(() => chat.sendMessage({ text: 'Stop' }))
      const message = Option.getOrThrow(Option.fromNullishOr(chat.lastMessage))
      expect(chat.status).toBe('ready')
      expect(message.parts.at(-1)).toEqual({ type: 'step-start' })
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      expect(Option.getOrThrow(Option.fromNullishOr(page.messages.at(-1))).parts).toEqual(
        message.parts,
      )
      const retry = new PlainChat({ transport: opened.transport, sendAutomaticallyWhen: automatic })
      retry.messages = [Option.getOrThrow(Option.fromNullishOr(chat.messages[0]))]
      yield* Effect.promise(() => retry.sendMessage())
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
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 100 }, 'old')])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Go' }))
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    const entries = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
    const user = entries.items.find((entry) => entry.kind === 'pi.user')
    if (user === undefined) throw new Error('Expected input entry')
    yield* Effect.promise(() => opened.root.reset(undefined, context))
    const receipt = yield* Effect.promise(() =>
      opened.root.submit(
        { type: 'write', entry: { kind: 'terminal.receipt', head: user.id } },
        context,
      ),
    )
    expect(yield* Effect.promise(() => receipt.status(context))).toMatchObject({
      type: 'write',
      status: 'unanswered',
      reason: 'stale',
    })
    const response = yield* Effect.promise(() =>
      respond(
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
      ),
    )
    expect(response.status).toBe(409)
  }),
)
