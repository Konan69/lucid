import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Queue, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider } from './provider.ts'
import { ChannelStore } from './store.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'
import { channelWorkerLayer } from './worker.ts'

describe.skipIf(!testDatabaseConfigured)('channel stream lifetime', () => {
  it.effect('reconnects on the Schedule and consumes linked text through Conversation', () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const control = yield* ChannelControl
      const store = yield* ChannelStore
      yield* store.connect(test.actor, 'iMessage', test.address)
      yield* Ref.set(control.disconnect, true)
      const context = yield* Effect.context<ChannelProvider | ChannelReceiver>()
      yield* Layer.build(channelWorkerLayer.pipe(Layer.provide(Layer.succeedContext(context))))
      yield* Queue.take(control.connections)
      yield* Queue.offer(control.inbound, yield* test.message('after reconnect'))
      yield* TestClock.adjust('2 seconds')
      yield* Queue.take(control.connections)
      // Runtime admission itself is the typed readiness signal, rather than polling persisted state.
      const send = yield* Queue.take(control.admitted)
      expect(send.message).toEqual({ kind: 'user', body: 'after reconnect', attachments: [] })
      const saved = yield* store.byPerson(test.actor.person.id, 'iMessage')
      expect(Option.isSome(saved) && saved.value.threadId !== null).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(channelTestLayer)),
  )
})
