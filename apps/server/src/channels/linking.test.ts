import { describe, expect, it } from '@effect/vitest'
import { ChannelAddress, ChannelStanding, RunState } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Ref, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { RunStore } from '../threads/runs.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelStore, channelStoreLayer } from './store.ts'
import { channelReceiverLayer } from './inbound.ts'
import { Database } from '../database/client.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'

const email = 'discord-channel@example.test'
const allowedLayer = channelTestLayer.pipe(
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_DISCORD_PEOPLE: email }), {
      asPrimary: true,
    }),
  ),
)
const sender = ChannelAddress.make('discord:523456789012345678')

describe.skipIf(!testDatabaseConfigured)('Discord channel linking', () => {
  it.effect('links a code DM, handles follow-up DMs and replies to guild mentions in place', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture(email)
        const store = yield* ChannelStore
        const receiver = yield* ChannelReceiver
        const control = yield* ChannelControl
        const receive = Effect.fn('Channels.test.discordReceive')(function* (
          text: string,
          conversation: string,
        ) {
          const message = yield* test.message(text)
          const place = { conversation, message: message.id }
          yield* receiver.receive({ ...message, channel: 'Discord', sender, place })
          return place
        })
        yield* receive('unlinked', 'dm')
        expect(yield* Ref.get(control.admissions)).toEqual([])
        expect(yield* Ref.get(control.sends)).toEqual([])
        const pending = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(pending.standing))
          return expect.fail('Expected a code')
        expect(pending.standing.code).toMatch(/^\d{6}$/u)
        expect(pending.standing.expiresAt).toBe(600000)
        expect((yield* store.list(test.actor)).find((link) => link.channel === 'Discord')).toEqual(
          pending,
        )
        const dm = yield* receive(` ${pending.standing.code} `, 'dm')
        const connected = yield* store.connect(test.actor, 'Discord')
        expect(connected.standing._tag).toBe('Connected')
        expect(
          Option.getOrThrow(yield* store.byPerson(test.actor.person.id, 'Discord')).address,
        ).toBe(sender)
        expect(yield* Ref.get(control.sends)).toEqual([
          {
            channel: 'Discord',
            address: sender,
            text: "Connected. Message me here, or mention me in any channel, and I'll answer.",
            place: dm,
          },
        ])
        for (const conversation of ['dm', 'guild-channel']) {
          const place = yield* receive('hello', conversation)
          const link = Option.getOrThrow(yield* store.byPerson(test.actor.person.id, 'Discord'))
          const runs = yield* (yield* RunStore).list(Option.getOrThrow(link.threadId))
          const run = runs.find((entry) => RunState.guards.Working(entry.state))
          if (run === undefined) return expect.fail('Expected an admitted Run')
          yield* test.finish(run.id, 'x'.repeat(4500))
          const sent = (yield* Ref.get(control.sends)).slice(-3)
          expect(sent.map((part) => part.text.length)).toEqual([2000, 2000, 500])
          expect(
            sent.every(
              (part) =>
                part.place !== undefined &&
                part.place.conversation === conversation &&
                part.place.message === place.message,
            ),
          ).toBe(true)
        }
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )

  it.effect('wrong and expired codes do not link, and disconnect removes a pending code', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture(email)
        const store = yield* ChannelStore
        const pending = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(pending.standing))
          return expect.fail('Expected a code')
        expect(yield* store.redeem('Discord', sender, `x${pending.standing.code}`)).toBe(false)
        yield* TestClock.adjust('10 minutes')
        expect(yield* store.redeem('Discord', sender, pending.standing.code)).toBe(false)
        expect(Option.isNone(yield* store.byPerson(test.actor.person.id, 'Discord'))).toBe(true)
        const renewed = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(renewed.standing))
          return expect.fail('Expected a new code')
        yield* store.disconnect(test.actor, 'Discord')
        expect(yield* store.redeem('Discord', sender, renewed.standing.code)).toBe(false)
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )

  it.effect('a redeem between disconnect database operations cannot leave a link', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture(email)
        const store = yield* ChannelStore
        const database = yield* Database
        const pending = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(pending.standing))
          return expect.fail('Expected a code')
        const code = pending.standing.code
        const raced = yield* Ref.make(false)
        const redeem = Ref.getAndSet(raced, true).pipe(
          Effect.flatMap((done) => (done ? Effect.void : store.redeem('Discord', sender, code))),
          Effect.asVoid,
        )
        const interleaved = Database.of({
          _: database._,
          query: database.query,
          $with: database.$with,
          $cache: database.$cache,
          $count: database.$count.bind(database),
          with: database.with.bind(database),
          select: database.select.bind(database),
          selectDistinct: database.selectDistinct.bind(database),
          selectDistinctOn: database.selectDistinctOn.bind(database),
          insert: database.insert.bind(database),
          update: database.update.bind(database),
          delete: database.delete.bind(database),
          refreshMaterializedView: database.refreshMaterializedView.bind(database),
          execute: database.execute.bind(database),
          run: (operation) => database.run(operation).pipe(Effect.tap(() => redeem)),
          transaction: (operation) =>
            database.transaction(operation).pipe(Effect.tap(() => redeem)),
        })
        const disconnectContext = yield* Layer.build(
          Layer.fresh(channelStoreLayer).pipe(
            Layer.provide(Layer.succeed(Database, interleaved)),
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_DISCORD_PEOPLE: email }), {
                asPrimary: true,
              }),
            ),
          ),
        )
        const other = yield* ChannelStore.pipe(Effect.provide(disconnectContext))
        const result = yield* other.disconnect(test.actor, 'Discord')
        expect(result.standing._tag).toBe('NotConnected')
        expect(yield* Ref.get(raced)).toBe(true)
        expect(Option.isNone(yield* store.byPerson(test.actor.person.id, 'Discord'))).toBe(true)
        expect(yield* store.redeem('Discord', sender, code)).toBe(false)
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )

  it.effect('revoked early access blocks pending redemption and linked inbound messages', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture(email)
        const store = yield* ChannelStore
        const pending = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(pending.standing))
          return expect.fail('Expected a code')
        const revokedContext = yield* Layer.build(
          Layer.fresh(channelReceiverLayer.pipe(Layer.provideMerge(channelStoreLayer))).pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        )
        const revokedStore = yield* ChannelStore.pipe(Effect.provide(revokedContext))
        expect(yield* revokedStore.redeem('Discord', sender, pending.standing.code)).toBe(false)
        const renewed = yield* store.connect(test.actor, 'Discord')
        if (!ChannelStanding.guards.Awaiting(renewed.standing))
          return expect.fail('Expected a renewed code')
        expect(yield* store.redeem('Discord', sender, renewed.standing.code)).toBe(true)
        const receiver = yield* ChannelReceiver.pipe(Effect.provide(revokedContext))
        yield* receiver.receive({ ...(yield* test.message('hello')), channel: 'Discord', sender })
        expect(yield* Ref.get((yield* ChannelControl).admissions)).toEqual([])
        expect(
          Option.isNone(
            Option.getOrThrow(yield* store.byPerson(test.actor.person.id, 'Discord')).threadId,
          ),
        ).toBe(true)
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )

  it.effect('hides Discord and refuses connect outside the email allowlist', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ChannelStore
        const discord = (yield* store.list(test.actor)).find((link) => link.channel === 'Discord')
        if (discord === undefined) return expect.fail('Expected Discord to be listed')
        expect(discord.standing._tag).toBe('Unavailable')
        const result = yield* store.connect(test.actor, 'Discord').pipe(Effect.result)
        expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
          'ChannelUnavailable',
        )
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )
})
