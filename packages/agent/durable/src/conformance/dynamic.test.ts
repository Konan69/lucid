import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'

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
import { call, context, host } from './fixtures/host.ts'
// AI SDK chat.test.ts:2988–3192 and process-ui-message-stream.test.ts:6343–6609 retain dynamic identity.
it.live(
  'answers a dynamic tool through stock Chat and keeps identity on reconnect and history',
  () =>
    Effect.gen(function* () {
      const fixture = yield* host(
        {
          ask: dynamicTool({
            title: 'Choose account',
            inputSchema: z.object({ question: z.string() }),
          }),
        },
        {},
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        call('ask', { question: 'Which?' }, 'ask'),
        fauxAssistantMessage('Answered.'),
      ])
      const finished = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onFinish: () => {
          if (opened.faux.state.callCount === 2) Deferred.doneUnsafe(finished, Effect.void)
        },
        onError: (error) =>
          Deferred.doneUnsafe(finished, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
      if (chat.lastMessage === undefined) throw new Error('Expected assistant')
      expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
        type: 'dynamic-tool',
        toolName: 'ask',
        title: 'Choose account',
        state: 'input-available',
      })
      const attached = yield* Effect.promise(() =>
        attachRun(opened.harness, opened.root.id, context),
      )
      if (attached.status === 'idle') throw new Error('Expected held run')
      expect(
        (yield* consumeReadable(attached.stream, Option.none())).message.parts.find(isToolUIPart),
      ).toEqual(chat.lastMessage.parts.find(isToolUIPart))
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })),
      )
      yield* Deferred.await(finished)
      expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
        type: 'dynamic-tool',
        state: 'output-available',
        output: 'Savings',
      })
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      const assistant = saved.messages.at(-1)
      if (assistant === undefined) throw new Error('Expected stored assistant')
      expect(assistant.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
    }),
)
// Upstream preliminary-result cases cover dynamic generators with and without approval; only the final yield survives.
it.live.each([true, false])('keeps dynamic generator identity after approved=%s', (approved) =>
  Effect.gen(function* () {
    let executions = 0
    const fixture = yield* host(
      {
        progress: dynamicTool({
          title: 'Invoice payment',
          inputSchema: z.object({}),
          // @effect-diagnostics-next-line asyncFunction:off -- subject: AI SDK dynamic generator tool must retain its native async iterator.
          execute: async function* () {
            executions++
            yield { status: 'loading' }
            yield { status: 'success' }
          },
        }),
      },
      { approval: { progress: true } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('progress', {}, 'progress'), fauxAssistantMessage('Settled.')])
    let finished = yield* Deferred.make<void, FixtureFailed>()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => Deferred.doneUnsafe(finished, Effect.void),
      onError: (error) =>
        Deferred.doneUnsafe(finished, Effect.fail(new FixtureFailed({ cause: error }))),
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    const held = chat.lastMessage.parts.find(isToolUIPart)
    if (held === undefined || held.state !== 'approval-requested')
      throw new Error('Expected approval')
    expect(held).toMatchObject({ type: 'dynamic-tool', title: 'Invoice payment' })
    finished = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: held.approval.id, approved })),
    )
    yield* Deferred.await(finished)
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
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const saved = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const assistant = saved.messages.at(-1)
    if (assistant === undefined) throw new Error('Expected stored assistant')
    expect(assistant.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
  }),
)
