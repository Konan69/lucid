import { runForPi } from '../pi.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, GenerationTask, hook, type EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { Effect, Predicate, Option, Deferred } from 'effect'

import { streamRun } from '../main.ts'
import { context, host, texts } from './fixtures/host.ts'

/** Raw entry identity, attribution and content cannot distinguish these native run boundaries.
 * generation.js:408–421 appends either an onYield continuation or queued inputs under the current
 * generation task. Its submission settlement, rather than the entry shape, names the run's end.
 * Harness.inspect exposes only queued/placed receipts (harness.js:151–157); Tx cannot scan them
 * (types.d.ts:663–721). scanSubmissions belongs to Storage, not the public Harness/Session reader. */
function visible(entries: readonly EntryRecord[]) {
  return entries.flatMap((entry) => {
    if (entry.kind !== 'pi.user' && entry.kind !== 'pi.assistant') return []
    return [
      {
        kind: entry.kind,
        attributed: entry.byTaskId !== undefined,
        texts: (entry.model === undefined ? [] : entry.model).flatMap((message) =>
          Predicate.isString(message.content)
            ? [message.content]
            : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        ),
      },
    ]
  })
}

/** Keep both native histories on real SQLite and consume the bridge through the SDK reader.
 * Provider gates leave time for follow-up admission without token rates, sleeps or polling. */
it.live(
  'retains distinct run boundaries for identical continuation and follow-up entry shapes',
  () =>
    Effect.gen(function* () {
      const histories: ReturnType<typeof visible>[] = []
      for (const mode of ['continuation', 'followUp'] as const) {
        const entered = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()

        const fixture = yield* host({}, {})
        const opened = yield* fixture.open([
          defineExtension({
            name: 'native-continuation',
            hooks: [
              hook(GenerationTask, {
                onYield: (answer) =>
                  mode === 'continuation' &&
                  answer.content.some((part) => part.type === 'text' && part.text === 'First.')
                    ? { continue: 'Follow' }
                    : undefined,
              }),
            ],
          }),
        ])
        // Release the provider before the scoped harness closes, including failed assertions.
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        opened.faux.setResponses([
          () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(entered, Effect.void)
                yield* Deferred.await(release)
                return fauxAssistantMessage('First.')
              }),
              undefined,
            ),
          fauxAssistantMessage('Final.'),
        ])
        const initial = yield* Effect.promise(() =>
          Promise.resolve(
            opened.root.submit(
              { type: 'input', content: 'Initial', requestId: 'initial' },
              context,
            ),
          ),
        )
        const stream = yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Initial', requestId: 'initial' },
              context,
            ),
          ),
        )
        yield* Deferred.await(entered)
        if (mode === 'followUp')
          yield* Effect.promise(() =>
            Promise.resolve(
              opened.root.submit(
                { type: 'input', content: 'Follow', requestId: 'follow', whenBusy: 'followUp' },
                context,
              ),
            ),
          )
        Deferred.doneUnsafe(release, Effect.void)
        const result = yield* consumeReadable(stream, Option.none())
        yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
        const entries = (yield* Effect.promise(() =>
          Promise.resolve(opened.root.entries({}, 100, undefined, context)),
        )).items.toReversed()
        histories.push(visible(entries))
        const users = entries.filter((entry) => entry.kind === 'pi.user')
        const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
        const lastAssistant = entries.findLast((entry) => entry.kind === 'pi.assistant')
        const user = users[1]
        if (user === undefined || assistant === undefined || lastAssistant === undefined)
          throw new Error('Expected native boundary entries')
        expect(user.byTaskId).toBe(assistant.byTaskId)
        // Both native paths store the same bare user payload, without a submission/run marker.
        expect(user.data).toBeUndefined()
        expect(user.head).toBeUndefined()
        expect(user.edits).toBeUndefined()
        expect(user.model).toEqual([
          { role: 'user', content: 'Follow', timestamp: expect.any(Number) },
        ])
        const receipt = yield* Effect.promise(() => Promise.resolve(initial.status(context)))
        expect(receipt.status).toBe('done')
        expect(receipt.answer).toBe(mode === 'continuation' ? lastAssistant.id : assistant.id)
        expect(
          (yield* Effect.promise(() => Promise.resolve(opened.harness.inspect(context))))
            .submissions,
        ).toEqual([])
        expect(texts(result.message)).toEqual(
          mode === 'continuation' ? ['First.', 'Final.'] : ['First.'],
        )
        expect(opened.faux.state.callCount).toBe(2)
      }
      expect(histories[0]).toEqual(histories[1])
    }),
)
