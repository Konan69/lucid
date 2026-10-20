import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { init, useModel } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import { createAgentRouter } from '@flue/runtime/routing'
import { createFlueClient, type AgentConversationObservationSnapshot } from '@flue/sdk'
import { textOf } from '@vivid/contracts'
import { Deferred, Effect, Option, Queue, Stream } from 'effect'
import { testDatabaseConfigured } from '../../../../apps/server/src/database/testdb.ts'
import { disposableStorage } from '../tests/schema.ts'

/** The public runtime owns projection; the test controls only the provider's content events. */
function Reply() {
  useModel('fixture/text')
  return 'Reply with the supplied content.'
}
Reply.agentName = 'reply'

/** A public observation notification, rather than a timer, acknowledges each transport milestone. */
const observed = (
  states: Queue.Queue<AgentConversationObservationSnapshot>,
  accepts: (state: AgentConversationObservationSnapshot) => boolean,
) =>
  Stream.fromQueue(states).pipe(
    Stream.filter(accepts),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

/**
 * Hono's in-process fetch does not abort response reads like network fetch. Couple the body to
 * the request signal so SDK cancellation cannot leave a stream reconnecting after Flue stops.
 */
function fetchRuntime(router: ReturnType<typeof createAgentRouter>): typeof fetch {
  return (input, options) => {
    const request = new Request(input, options)
    request.signal.throwIfAborted()
    return Promise.resolve(router.fetch(request)).then((response) => {
      request.signal.throwIfAborted()
      if (response.body === null) return response
      return new Response(
        response.body.pipeThrough(new TransformStream(), { signal: request.signal }),
        response,
      )
    })
  }
}

/** Reproduce the provider's content indexes before Flue translates them into UI chunks. */
function sequence(distinct: boolean) {
  const message = fauxAssistantMessage(
    distinct
      ? [
          { type: 'text', text: 'First is done.' },
          { type: 'thinking', thinking: '.' },
          { type: 'text', text: 'Next topic begins.' },
        ]
      : [
          { type: 'text', text: '**Why Rivers Meander**' },
          { type: 'thinking', thinking: '.' },
        ],
  )
  const events: AssistantMessageEvent[] = [
    { type: 'start', partial: message },
    { type: 'text_start', contentIndex: 0, partial: message },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: distinct ? 'First is done.' : '**',
      partial: message,
    },
  ]
  if (distinct)
    events.push({ type: 'text_end', contentIndex: 0, content: 'First is done.', partial: message })
  events.push(
    { type: 'thinking_start', contentIndex: 1, partial: message },
    { type: 'thinking_delta', contentIndex: 1, delta: '.', partial: message },
    { type: 'thinking_end', contentIndex: 1, content: '.', partial: message },
  )
  if (distinct) {
    events.push(
      { type: 'text_start', contentIndex: 2, partial: message },
      { type: 'text_delta', contentIndex: 2, delta: 'Next topic begins.', partial: message },
      { type: 'text_end', contentIndex: 2, content: 'Next topic begins.', partial: message },
    )
  } else {
    events.push(
      { type: 'text_delta', contentIndex: 0, delta: 'Why Rivers Meander**', partial: message },
      { type: 'text_end', contentIndex: 0, content: '**Why Rivers Meander**', partial: message },
    )
  }
  events.push({ type: 'done', reason: 'stop', message })
  return events
}

describe.skipIf(!testDatabaseConfigured)('Flue live reply reconciliation', () => {
  for (const distinct of [false, true]) {
    it.live.each(['sse', 'long-poll'] as const)(
      distinct
        ? 'keeps distinct text blocks separated by thinking as two paragraphs via %s'
        : 'reconciles text, thinking, and text from the same block to one text part via %s',
      (transport) =>
        Effect.gen(function* () {
          const { storage } = yield* disposableStorage
          const entered = Deferred.makeUnsafe<void>()
          const source = createAssistantMessageEventStream()
          const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'text' }] })
          // Provider registration is public. Flue, its wire encoder, and SDK reducer stay real.
          const stream = () => {
            Deferred.doneUnsafe(entered, Effect.void)
            return source
          }
          yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              start({
                agents: [Reply],
                db: storage,
                providers: [{ ...faux.provider, stream, streamSimple: stream }],
              }),
            ),
            (runtime) => Effect.promise(() => runtime.stop()),
          )
          // Even a failed assertion must let Flue drain before its stop finalizer runs.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => source.end(fauxAssistantMessage('stopped'))),
          )
          const id = NodeCrypto.randomUUID()
          const router = createAgentRouter(Reply)
          const client = createFlueClient({
            url: `http://runtime.test/${id}`,
            fetch: fetchRuntime(router),
          })
          const receipt = yield* Effect.tryPromise(() => init(Reply, { id }).dispatch('reply'))
          yield* Deferred.await(entered)
          const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
          const observation = yield* Effect.acquireRelease(
            Effect.sync(() => client.observe({ live: transport, limit: 1 })),
            (value) => Effect.sync(() => value.close()),
          )
          const changed = () => {
            Queue.offerUnsafe(states, observation.getSnapshot())
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => observation.subscribe(changed)),
            (unsubscribe) => Effect.sync(unsubscribe),
          )
          changed()
          yield* observed(states, (state) => state.phase === 'live')
          for (const event of sequence(distinct)) source.push(event)
          const completed = yield* observed(
            states,
            (state) =>
              state.conversation !== undefined &&
              state.conversation.settlements.some(
                (settled) => settled.submissionId === receipt.submissionId,
              ),
          )
          const conversation = completed.conversation
          if (conversation === undefined) return expect.fail('The observed conversation must exist')
          const live = conversation.messages.find((message) => message.role === 'assistant')
          const stored = yield* Effect.tryPromise(() => client.history())
          const canonical = stored.messages.find((message) => message.role === 'assistant')
          if (live === undefined || canonical === undefined)
            return expect.fail('The completed reply must exist in observation and history')
          expect(live.parts).toEqual(canonical.parts)
          expect(live.parts.filter((part) => part.type === 'text')).toHaveLength(distinct ? 2 : 1)
          expect(textOf(live)).toBe(
            distinct ? 'First is done.\n\nNext topic begins.' : '**Why Rivers Meander**',
          )
        }).pipe(Effect.scoped),
    )
  }
})
