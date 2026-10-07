import { Deferred, Effect, Option, Predicate, Schema } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
} from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { host } from './fixtures/host.ts'
const partial = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))
/** Stock predicates settle streamed inputs in both host modes, without exposing queued successors. */
for (const execution of ['parallel', 'sequential'] as const)
  it.live.each(['approve', 'deny', 'output'] as const)(
    `${execution} streams inputs before stock %s settlement`,
    (settlement) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const visible = yield* Deferred.make<void>()
        let gated = false
        const ran: string[] = []
        const fixture = yield* host(
          {
            work:
              settlement === 'output'
                ? tool({ inputSchema: z.object({ input: z.string() }) })
                : tool({
                    inputSchema: z.object({ input: z.string() }),
                    execute: ({ input }) => {
                      ran.push(input)
                      return Promise.resolve(input)
                    },
                  }),
          },
          settlement === 'output'
            ? { execution, answers: { work: 'wait' } }
            : { execution, approval: { work: true } },
          { toolExecution: execution, progress: { partialIntervalMs: 1 } },
          {
            partialFamily: 'anthropic',
            tokenSize: { min: 1, max: 1 },
            onFrame: (event, abortSignal) => {
              if (event.type !== 'toolcall_delta' || gated) return Effect.void
              const block = event.partial.content[event.contentIndex]
              if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
              if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 5)
                return Effect.void
              gated = true
              return waitForFrame(Deferred.await(release), abortSignal)
            },
          },
        )
        const opened = yield* fixture.open()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)),
        )
        opened.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall('work', { input: 'first input' }, { id: 'c1' }),
              fauxToolCall('work', { input: 'second input' }, { id: 'c2' }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Done.'),
        ])
        let finished = yield* Deferred.make<void, FixtureFailed>()
        const chat = new PlainChat({
          transport: opened.transport,
          sendAutomaticallyWhen:
            settlement === 'output'
              ? lastAssistantMessageIsCompleteWithToolCalls
              : lastAssistantMessageIsCompleteWithApprovalResponses,
          onFinish: () => Deferred.doneUnsafe(finished, Effect.void),
          onError: (error) =>
            Deferred.doneUnsafe(finished, Effect.fail(new FixtureFailed({ cause: error }))),
          onMessage: (message) => {
            const first = message.parts.find(isToolUIPart)
            if (first === undefined || first.state !== 'input-streaming') return
            const decoded = partial(first.input)
            if (Option.isSome(decoded) && decoded.value.input.length >= 5)
              Deferred.doneUnsafe(visible, Effect.void)
          },
        })
        const sent = chat.sendMessage({ text: 'Work twice' })
        yield* Deferred.await(visible)
        expect(ran).toEqual([])
        Deferred.doneUnsafe(release, Effect.void)
        yield* Effect.promise(() => sent)
        for (const id of ['c1', 'c2']) {
          if (chat.lastMessage === undefined) throw new Error('Expected assistant')
          const part = chat.lastMessage.parts.find(
            (candidate) => isToolUIPart(candidate) && candidate.toolCallId === id,
          )
          if (part === undefined || !isToolUIPart(part)) throw new Error('Expected presented call')
          finished = yield* Deferred.make<void, FixtureFailed>()
          if (settlement === 'output') {
            expect(part.state).toBe('input-available')
            yield* Effect.promise(() =>
              Promise.resolve(
                chat.addToolOutput({ tool: 'work', toolCallId: id, output: `answer:${id}` }),
              ),
            )
          } else {
            if (part.state !== 'approval-requested') throw new Error('Expected approval')
            yield* Effect.promise(() =>
              Promise.resolve(
                chat.addToolApprovalResponse({
                  id: part.approval.id,
                  approved: settlement === 'approve',
                }),
              ),
            )
          }
          if (execution === 'sequential' || id === 'c2') yield* Deferred.await(finished)
        }
        expect(chat.status).toBe('ready')
        expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
        if (chat.lastMessage === undefined) throw new Error('Expected final assistant')
        const parts = chat.lastMessage.parts.filter(isToolUIPart)
        expect(parts.map((part) => part.toolCallId)).toEqual(['c1', 'c2'])
        expect(parts.map((part) => part.state)).toEqual(
          settlement === 'deny'
            ? ['output-denied', 'output-denied']
            : ['output-available', 'output-available'],
        )
        expect(ran).toEqual(settlement === 'approve' ? ['first input', 'second input'] : [])
      }),
  )
