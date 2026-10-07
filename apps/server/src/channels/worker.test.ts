import { describe, expect, it } from '@effect/vitest'
import { Duration, Effect, Layer, Option, Queue, Ref, Schedule } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider } from './provider.ts'
import { ChannelStore } from './store.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'
import { channelReconnect, channelWorkerLayer } from './worker.ts'

describe('channel reconnect policy', () => {
  it.effect(
    'grows exponentially with jitter, caps at a minute and resets after inbound progress',
    () =>
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(channelReconnect)
        for (let attempt = 0; attempt < 12; attempt++) {
          const [, delay] = yield* step(0, false)
          const base = 2000 * 2 ** attempt
          expect(Duration.toMillis(delay)).toBeGreaterThanOrEqual(Math.min(base * 0.8, 60000))
          expect(Duration.toMillis(delay)).toBeLessThanOrEqual(Math.min(base * 1.2, 60000))
        }
        const [, reset] = yield* step(0, true)
        expect(Duration.toMillis(reset)).toBeGreaterThanOrEqual(1600)
        expect(Duration.toMillis(reset)).toBeLessThanOrEqual(2400)
      }),
  )
})

/** Each consumer gets its own inbound queue so message defects cannot consume another case's input. */
describe.skipIf(!testDatabaseConfigured)('channel stream lifetime', () => {
  it.effect('one defective message cannot end the scoped consumer', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const control = yield* ChannelControl
        yield* (yield* ChannelStore).connect(test.actor, 'iMessage', test.address)
        const receiver = yield* ChannelReceiver
        const calls = yield* Ref.make(0)
        const guarded = Layer.succeed(ChannelReceiver, {
          receive: Effect.fn('Channels.test.defect')(function* (message) {
            if ((yield* Ref.getAndUpdate(calls, (count) => count + 1)) === 0)
              return yield* Effect.die('private provider payload')
            return yield* receiver.receive(message)
          }),
        })
        const context = yield* Effect.context<ChannelProvider>()
        yield* Layer.build(
          channelWorkerLayer.pipe(
            Layer.provide(guarded),
            Layer.provide(Layer.succeedContext(context)),
          ),
        )
        yield* Queue.take(control.connections)
        yield* Queue.offer(control.inbound, yield* test.message('first packet'))
        yield* Queue.offer(control.inbound, yield* test.message('still alive'))
        expect((yield* Queue.take(control.admitted)).message).toEqual({
          kind: 'user',
          body: 'still alive',
          attachments: [],
        })
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect('reconnects on the Schedule and consumes linked text through Conversation', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const control = yield* ChannelControl
        const store = yield* ChannelStore
        yield* store.connect(test.actor, 'iMessage', test.address)
        yield* Ref.set(control.disconnect, true)
        const context = yield* Effect.context<ChannelProvider | ChannelReceiver>()
        yield* Layer.build(channelWorkerLayer.pipe(Layer.provide(Layer.succeedContext(context))))
        yield* Queue.take(control.connections)
        yield* Queue.offer(control.inbound, yield* test.message('after reconnect'))
        yield* TestClock.adjust('3 seconds')
        yield* Queue.take(control.connections)
        // Runtime admission itself is the typed readiness signal, rather than polling persisted state.
        const send = yield* Queue.take(control.admitted)
        expect(send.message).toEqual({ kind: 'user', body: 'after reconnect', attachments: [] })
        const saved = yield* store.byPerson(test.actor.person.id, 'iMessage')
        expect(Option.isSome(saved) && Option.isSome(saved.value.threadId)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
})
