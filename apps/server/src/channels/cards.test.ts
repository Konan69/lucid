import { describe, expect, it } from '@effect/vitest'
import {
  ChannelAddress,
  ChannelStanding,
  InputRequestState,
  InputAnswer,
  ApprovalState,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Queue, Ref } from 'effect'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { InputStore } from '../inputs/store.ts'
import { ApprovalStore } from '../approvals/store.ts'
import { desktopAction } from '../approvals/testing.ts'
import { unbound } from '../approvals/action.ts'
import { deliveryRunId } from '../threads/key.ts'
import { ChannelStore } from './store.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'

const email = 'discord-cards@example.test'
const allowed = channelTestLayer.pipe(
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_DISCORD_PEOPLE: email }), {
      asPrimary: true,
    }),
  ),
)

describe.skipIf(!testDatabaseConfigured)('Discord text cards', () => {
  it.effect(
    'renders numbered choices and settles the same Input request and Approval from typed replies',
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(allowed)
        yield* Effect.gen(function* () {
          const test = yield* fixture(email)
          const store = yield* ChannelStore
          const receiver = yield* ChannelReceiver
          const control = yield* ChannelControl
          const sender = ChannelAddress.make('discord:523456789012345679')
          const receive = Effect.fn('Channels.test.cardReply')(function* (text: string) {
            const message = yield* test.message(text)
            yield* receiver.receive({
              ...message,
              channel: 'Discord',
              sender,
              place: { conversation: 'dm', message: message.id },
            })
          })
          const pending = yield* store.connect(test.actor, 'Discord')
          if (!ChannelStanding.guards.Awaiting(pending.standing))
            return expect.fail('Expected linking code')
          yield* receive(pending.standing.code)
          yield* receive('Help me pick')
          const admitted = yield* Queue.take(control.admitted)
          const vivid = {
            ...test.actor,
            by: 'vivid' as const,
            threadId: Option.some(admitted.threadId),
          }
          const inputs = yield* InputStore
          const approvals = yield* ApprovalStore
          const request = yield* inputs.ask(vivid, {
            questions: [
              {
                question: 'Which colour?',
                options: [
                  { label: 'Blue', detail: 'Cool' },
                  { label: 'Red', detail: 'Warm' },
                ],
                selection: 'One',
                allowsOwnAnswer: true,
              },
            ],
          })
          const approval = yield* approvals.raise(vivid, desktopAction, unbound)
          yield* test.finish(
            deliveryRunId(admitted.threadId, admitted.idempotencyKey),
            'Pick a colour and decide.',
          )
          const sent = (yield* Ref.get(control.sends)).map((send) => send.text).join('\n')
          expect(sent).toContain('1) Blue: Cool\n2) Red: Warm')
          expect(sent).toContain(`answer ${request.id}:`)
          expect(sent).toContain(`approve ${approval.id} ${approval.digest}: 1 or 2`)
          yield* receive(`answer ${request.id}: 2`)
          const answered = (yield* inputs.inThread(admitted.threadId)).find(
            (value) => value.id === request.id,
          )
          if (answered === undefined || !InputRequestState.guards.Answered(answered.state))
            return expect.fail('Question was not answered')
          expect(answered.state.answers).toEqual([
            InputAnswer.cases.Chosen.make({ labels: ['Red'] }),
          ])
          const continuation = yield* Queue.take(control.admitted)
          expect(continuation.message._tag).toBe('Signal')
          yield* test.finish(
            deliveryRunId(continuation.threadId, continuation.idempotencyKey),
            'Red it is.',
          )
          yield* receive(`approve ${approval.id} ${approval.digest}: 2`)
          const denied = (yield* approvals.inThread(admitted.threadId)).find(
            (value) => value.id === approval.id,
          )
          expect(denied !== undefined && ApprovalState.guards.Denied(denied.state)).toBe(true)
          const decision = yield* Queue.take(control.admitted)
          expect(decision.message._tag).toBe('Signal')
          yield* test.finish(deliveryRunId(decision.threadId, decision.idempotencyKey), 'Refused.')
          expect((yield* Ref.get(control.sends)).map((send) => send.text)).toContain('Refused.')
        }).pipe(Effect.provide(context), Effect.scoped)
      }).pipe(Effect.scoped),
  )
})
