import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { ConversationFrame, type ConversationState } from '@vivid/contracts'
import { Effect, Fiber, Option, Queue, Stream } from 'effect'
import { chainFixture, chainLayer, completeRun } from '../runtime/chains.ts'

/**
 * One cookie-authenticated live chain proves the relay against the real product and Flue.
 * Run on the primary's disposable stack with VIVID_LIVE_CONVERSATION_RELAY=1. This intentionally
 * uses the existing chain fixture's database equality guard and cleanup, never a second harness.
 */
layer(chainLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(process.env['VIVID_LIVE_CONVERSATION_RELAY'] !== '1')(
    'Conversation relay',
    () => {
      it.effect('hydrates real history and echoes a keyed send through its settled reply', () =>
        Effect.gen(function* () {
          const fixture = yield* chainFixture('Conversation relay proof')
          const original = 'Remember the phrase amber orchard. Reply with a short acknowledgement.'
          const earlier = yield* fixture.send(original)
          yield* completeRun(fixture, earlier)
          const frames = yield* Queue.unbounded<ConversationState>()
          const watching = yield* fixture.rpc
            .WatchConversation({ threadId: fixture.threadId })
            .pipe(
              Stream.runForEach((frame) => {
                expect(ConversationFrame.guards.Whole(frame), 'Every Flue frame is a Whole').toBe(
                  true,
                )
                return ConversationFrame.match(frame, {
                  Whole: ({ state }) => Queue.offer(frames, state),
                  Changes: () => Effect.sync(() => expect.fail('Expected a Whole frame')),
                })
              }),
              Effect.forkScoped,
            )
          // A closed or failed subscription fails the wait, rather than hiding behind Queue.take.
          const next = (accepts: (state: ConversationState) => boolean) =>
            Stream.fromEffectRepeat(Queue.take(frames)).pipe(
              Stream.filter(accepts),
              Stream.runHead,
              Effect.raceFirst(
                Fiber.join(watching).pipe(
                  Effect.andThen(() =>
                    Effect.sync(() => expect.fail('The conversation link ended')),
                  ),
                ),
              ),
              Effect.map((found) => Option.getOrThrow(found)),
            )
          const first = yield* next(() => true)
          expect(
            first.messages.some((message) =>
              message.parts.some((part) => part.type === 'text' && part.text === original),
            ),
          ).toBe(true)
          const key = NodeCrypto.randomUUID()
          const text = 'What phrase did I ask you to remember? Reply with only the phrase.'
          const { run } = yield* fixture.rpc.SendToThread({
            threadId: fixture.threadId,
            text,
            pictures: [],
            key,
          })
          expect(run.submissionId).toBe(run.id)
          const echoed = yield* next((state) =>
            state.messages.some((message) => message.key === key),
          )
          expect(echoed.messages.filter((message) => message.key === key)).toMatchObject([
            {
              submissionId: run.id,
              parts: [{ type: 'text', text }],
            },
          ])
          const ended = yield* next(
            (state) =>
              !state.working &&
              state.settlements.some(
                (settlement) =>
                  settlement.submissionId === run.id && settlement.outcome === 'completed',
              ),
          )
          expect(
            ended.settlements.find((settlement) => settlement.submissionId === run.id),
          ).toMatchObject({
            answeredBy: run.id,
          })
          expect(
            ended.messages.some(
              (message) => message.role === 'assistant' && message.submissionId === run.id,
            ),
          ).toBe(true)
          expect(ended.queued).toBe(0)
          const reconnected = yield* fixture.rpc
            .WatchConversation({ threadId: fixture.threadId })
            .pipe(Stream.runHead)
          expect(Option.isSome(reconnected)).toBe(true)
          if (Option.isSome(reconnected)) {
            expect(ConversationFrame.guards.Whole(reconnected.value)).toBe(true)
          }
          if (Option.isSome(reconnected) && ConversationFrame.guards.Whole(reconnected.value)) {
            expect(reconnected.value.state.messages.some((message) => message.key === key)).toBe(
              true,
            )
          }
        }).pipe(Effect.scoped),
      )
    },
  )
})
