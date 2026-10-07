import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Option } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { followRun, history } from '../main.ts'
import * as Pi from '../pi.ts'
import { context, host } from './fixtures/host.ts'

/** Pi live.ts settleSchedulerOutcome appends a committed partial on the scheduler's commit,
 * outside the failed generation's task scope. Preserve its honest entry identity after reload;
 * no arithmetic can give that unattributed assistant the generation's original live identity. */
it.live(
  'a scheduler-written fault partial changes from generation identity to entry identity',
  () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, { commitFrames: true })
      const fault = defineExtension({
        name: 'fault-partial',
        hooks: [
          hook(GenerationTask, {
            // A non-JSON provider value faults the append after its valid partial was committed.
            afterResponse: (message) => {
              Object.assign(message, { poison: () => 'not JSON' })
            },
          }),
        ],
      })
      const opened = yield* fixture.open([fault])
      opened.faux.setResponses([fauxAssistantMessage('Committed partial.')])
      const chat = new PlainChat({ transport: opened.transport, generateId: () => 'fault' })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Go' }))
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      const receipt = yield* Pi.request(opened.root, 'fault', context)
      if (Option.isNone(receipt)) throw new Error('Expected admitted input')
      const live = chat.lastMessage
      if (live === undefined) throw new Error('Expected live assistant')
      expect(live.id).toBe(`gen:${receipt.value.id + 1}`)
      const entries = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
      const partial = entries.items.find((entry) => entry.kind === 'pi.assistant')
      if (partial === undefined) throw new Error('Expected scheduler partial')
      expect(partial.byTaskId).toBeUndefined()
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      const assistant = saved.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected history assistant')
      expect(assistant.id).toBe(`entry:${partial.id}`)
      expect(assistant.parts).toEqual(live.parts)
      const replayed = yield* consumeReadable(
        yield* Effect.promise(() => followRun(opened.harness, opened.root.id, 'fault', context)),
        Option.none(),
      )
      expect(replayed.message.id).toBe(assistant.id)
      expect(replayed.message.parts).toEqual(assistant.parts)
    }),
)

/** With no assistant entry the fold can resolve before or after termination. A delayed transport
 * acquisition selects the latter without a timer; observing start selects the former. Neither
 * empty identity is persisted as an assistant, and a later replay must use the input entry. */
it.live.each(['before', 'after'] as const)(
  'an empty abort %s the first start has one empty Chat message and no history assistant',
  (timing) =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {})
      const opened = yield* fixture.open()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const acquired = yield* Deferred.make<void>()
      const permit = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() =>
        Effect.all([Deferred.succeed(release, undefined), Deferred.succeed(permit, undefined)]),
      )
      opened.faux.setResponses([
        (_messages, options) =>
          Pi.runForPi(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(
                waitForFrame(
                  Deferred.await(release),
                  Option.fromNullishOr(options === undefined ? undefined : options.signal),
                ),
              ),
              Effect.as(fauxAssistantMessage('Not delivered.')),
            ),
            undefined,
          ),
      ])
      const chat = new PlainChat({
        generateId: () => 'empty',
        transport: {
          sendMessages: (options) =>
            Pi.runForPi(
              Effect.gen(function* () {
                const stream = yield* Effect.promise(() => opened.transport.sendMessages(options))
                yield* Deferred.succeed(acquired, undefined)
                if (timing === 'before') yield* Deferred.await(permit)
                return stream.pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      if (chunk.type === 'start') Deferred.doneUnsafe(started, Effect.void)
                      controller.enqueue(chunk)
                    },
                  }),
                )
              }),
              undefined,
            ),
          reconnectToStream: (options) => opened.transport.reconnectToStream(options),
        },
      })
      const sending = yield* Effect.forkScoped(
        Effect.promise(() => chat.sendMessage({ text: 'Go' })),
        { startImmediately: true },
      )
      yield* Deferred.await(entered)
      yield* Deferred.await(timing === 'before' ? acquired : started)
      yield* Effect.promise(() => opened.root.abort(context))
      yield* Deferred.succeed(permit, undefined)
      yield* Fiber.join(sending)
      const receipt = yield* Pi.request(opened.root, 'empty', context)
      if (Option.isNone(receipt) || receipt.value.entry === undefined)
        throw new Error('Expected placed input')
      const live = chat.lastMessage
      if (live === undefined) throw new Error('Expected empty assistant')
      expect(live.id).toBe(
        timing === 'before' ? `input:${receipt.value.entry}` : `gen:${receipt.value.id + 1}`,
      )
      expect(chat.messages.filter((message) => message.role === 'assistant')).toEqual([live])
      expect(live.parts).toEqual([{ type: 'step-start' }])
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      expect(saved.messages.map((message) => message.role)).toEqual(['user'])
      const replayed = yield* consumeReadable(
        yield* Effect.promise(() => followRun(opened.harness, opened.root.id, 'empty', context)),
        Option.none(),
      )
      expect(replayed.message.id).toBe(`input:${receipt.value.entry}`)
      expect(replayed.message.parts).toEqual([])
    }),
)
