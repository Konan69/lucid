import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, GenerationTask, hook, type EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { Effect, Predicate } from 'effect'
import { onTestFinished } from 'vitest'
import { streamRun } from '../main.ts'
import { consume, context, host, signal, texts } from './fixtures/host.ts'

/** Raw entry identity, attribution and content cannot distinguish these native run boundaries.
 * generation.js:408–421 appends either an onYield continuation or queued inputs under the current
 * generation task. Its submission settlement, rather than the entry shape, names the run's end. */
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
    Effect.promise(async () => {
      const histories: ReturnType<typeof visible>[] = []
      for (const mode of ['continuation', 'followUp'] as const) {
        const entered = signal()
        const release = signal()
        onTestFinished(() => release.resolve())
        const fixture = await host({}, {})
        const opened = await fixture.open([
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
        opened.faux.setResponses([
          async () => {
            entered.resolve()
            await release.promise
            return fauxAssistantMessage('First.')
          },
          fauxAssistantMessage('Final.'),
        ])
        const stream = await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Initial', requestId: 'initial' },
          context,
        )
        await entered.promise
        if (mode === 'followUp')
          await opened.root.submit(
            { type: 'input', content: 'Follow', requestId: 'follow', whenBusy: 'followUp' },
            context,
          )
        release.resolve()
        const result = await consume(stream)
        await opened.root.waitForIdle(context)
        const entries = (await opened.root.entries({}, 100, undefined, context)).items.toReversed()
        histories.push(visible(entries))
        const users = entries.filter((entry) => entry.kind === 'pi.user')
        const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
        const user = users[1]
        if (user === undefined || assistant === undefined)
          throw new Error('Expected native boundary entries')
        expect(user.byTaskId).toBe(assistant.byTaskId)
        expect(texts(result.message)).toEqual(
          mode === 'continuation' ? ['First.', 'Final.'] : ['First.'],
        )
        expect(opened.faux.state.callCount).toBe(2)
      }
      expect(histories[0]).toEqual(histories[1])
    }),
)
