import { describe, expect, it } from '@effect/vitest'
import { ChannelAddress, ChannelStanding, RunState } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Ref, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { RunStore } from '../threads/runs.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelStore } from './store.ts'
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
                part.place?.conversation === conversation && part.place.message === place.message,
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

  it.effect('hides Discord and refuses connect outside the email allowlist', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(allowedLayer)
      yield* Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ChannelStore
        expect(
          (yield* store.list(test.actor)).find((link) => link.channel === 'Discord')?.standing._tag,
        ).toBe('Unavailable')
        const result = yield* store.connect(test.actor, 'Discord').pipe(Effect.result)
        expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
          'ChannelUnavailable',
        )
      }).pipe(Effect.provide(context), Effect.scoped)
    }).pipe(Effect.scoped),
  )
})
