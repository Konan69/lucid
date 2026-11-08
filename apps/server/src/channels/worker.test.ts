import { RuntimeDelivery } from '@vivid/contracts'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Logger, Option, Queue, Ref, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { SpectrumCloudError } from 'spectrum-ts'
import { disconnected } from './photon.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider } from './provider.ts'
import { ChannelStore } from './store.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'
import { channelWorkerLayer } from './worker.ts'

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
        expect((yield* Queue.take(control.admitted)).message).toEqual(
          RuntimeDelivery.cases.Words.make({ body: 'still alive', attachments: [] }),
        )
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  /** SDK 4xx evidence must reach the worker unchanged: a 403 can recover while 401 stops
   * captured credentials. A linked message proves recovery through real persisted routing. */
  it.effect('reconnects after non-401 refusals and stops only on 401', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const control = yield* ChannelControl
        yield* (yield* ChannelStore).connect(test.actor, 'iMessage', test.address)
        const provider = yield* ChannelProvider
        const receiver = yield* ChannelReceiver
        const attempts = yield* Ref.make(0)
        const failures = yield* Queue.unbounded<string>()
        const capture = Logger.make(({ logLevel }) => {
          Queue.offerUnsafe(failures, logLevel)
        })
        const inbound = Stream.unwrap(
          Effect.gen(function* () {
            const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1)
            if (attempt === 0)
              return Stream.fail(disconnected(new SpectrumCloudError(403, 'TEMPORARY', 'private')))
            if (attempt === 1)
              return Stream.make(yield* test.message('recovered')).pipe(
                Stream.concat(
                  Stream.fail(disconnected(new SpectrumCloudError(401, 'UNAUTHORIZED', 'private'))),
                ),
              )
            return provider.inbound
          }),
        )
        yield* Layer.build(
          channelWorkerLayer.pipe(
            Layer.provide(
              Layer.succeed(ChannelProvider, ChannelProvider.of({ ...provider, inbound })),
            ),
            Layer.provide(Layer.succeed(ChannelReceiver, receiver)),
            Layer.provide(Logger.layer([capture])),
          ),
        )
        expect(yield* Queue.take(failures)).toBe('Error')
        yield* TestClock.adjust('3 seconds')
        expect((yield* Queue.take(control.admitted)).message).toEqual(
          RuntimeDelivery.cases.Words.make({ body: 'recovered', attachments: [] }),
        )
        yield* Queue.take(failures)
        yield* TestClock.adjust('10 minutes')
        expect(yield* Ref.get(attempts)).toBe(2)
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
        expect(send.message).toEqual(
          RuntimeDelivery.cases.Words.make({ body: 'after reconnect', attachments: [] }),
        )
        const saved = yield* store.byPerson(test.actor.person.id, 'iMessage')
        expect(Option.isSome(saved) && Option.isSome(saved.value.threadId)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
})
