import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
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
