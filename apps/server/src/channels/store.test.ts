import { describe, expect, it } from '@effect/vitest'
import {
  ChannelAddress,
  ChannelProviderFailed,
  ChannelStanding,
  type ChannelListResponse,
} from '@vivid/contracts'
import { Deferred, Effect, Fiber, Option, Queue, Ref, Result, Stream, Layer } from 'effect'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { nextValue } from '../live/testing.ts'
import { channelHandlers } from './handlers.ts'
import { ChannelStore } from './store.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'

/** Every watch must return one entry for each closed channel before its state can be asserted. */
const firstChannel = (response: ChannelListResponse) => {
  const channel = response.channels[0]
  if (channel === undefined) return expect.fail('Missing iMessage standing')
  return channel
}

/** Refusals are asserted through the public RPC seam, including authenticated personal ownership. */
describe.skipIf(!testDatabaseConfigured)('personal channel linking', () => {
  it.effect('a channel Vivid does not text on yet stands Unavailable and refuses a number', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ChannelStore
        expect(
          (yield* store.list(test.actor)).map((link) => [link.channel, link.standing._tag]),
        ).toEqual([
          ['iMessage', 'NotConnected'],
          ['WhatsApp', 'Unavailable'],
        ])
        const result = yield* store
          .connect(test.actor, 'WhatsApp', test.address)
          .pipe(Effect.result)
        expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
          'ChannelUnavailable',
        )
        expect(yield* Ref.get((yield* ChannelControl).enrols)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
  it.effect(
    'rejects local numbers, malformed numbers and email enrolment before provider I/O',
    () =>
      Effect.gen(function* () {
        // Each case owns fresh mutable services and their resource scope.
        const caseContext = yield* Layer.build(channelTestLayer)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          for (const address of ['2025550123', '+000123', 'ada@example.test']) {
            const result = yield* channelHandlers
              .ConnectChannel({ channel: 'iMessage', address })
              .pipe(test.signedIn, Effect.result)
            expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
              'ChannelAddressInvalid',
            )
          }
          expect(yield* Ref.get((yield* ChannelControl).enrols)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  it.effect('connects immediately with the assigned line and reuses the enrolment on repeat', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const connect = () =>
          channelHandlers
            .ConnectChannel({ channel: 'iMessage', address: test.address })
            .pipe(test.signedIn)
        const first = (yield* connect()).link
        expect(first.standing).toEqual(
          ChannelStanding.cases.Connected.make({
            address: test.address,
            textTo: ChannelAddress.make('+12025550100'),
            since: 0,
          }),
        )
        expect((yield* connect()).link).toEqual(first)
        expect(yield* Ref.get((yield* ChannelControl).enrols)).toEqual([test.address])
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'refuses another Person’s claimed address without enrolling it or exposing that Person',
    () =>
      Effect.gen(function* () {
        // Each case owns fresh mutable services and their resource scope.
        const caseContext = yield* Layer.build(channelTestLayer)
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const other = yield* fixture()
          yield* channelHandlers
            .ConnectChannel({ channel: 'iMessage', address: test.address })
            .pipe(test.signedIn)
          const result = yield* channelHandlers
            .ConnectChannel({ channel: 'iMessage', address: test.address })
            .pipe(other.signedIn, Effect.result)
          expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
            'ChannelAddressTaken',
          )
          expect(JSON.stringify(result)).not.toContain(test.actor.person.id)
          expect(yield* Ref.get((yield* ChannelControl).enrols)).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  it.effect('preserves provider refusals without creating a link', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const control = yield* ChannelControl
        for (const failure of [new ChannelProviderFailed({ channel: 'iMessage' })]) {
          yield* Ref.set(control.failure, Option.some(failure))
          const result = yield* channelHandlers
            .ConnectChannel({ channel: 'iMessage', address: test.address })
            .pipe(test.signedIn, Effect.result)
          expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(failure._tag)
          expect(
            Option.isNone(yield* (yield* ChannelStore).byPerson(test.actor.person.id, 'iMessage')),
          ).toBe(true)
        }
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect('disconnect removes ownership and the enrolment and can be repeated', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        yield* channelHandlers
          .ConnectChannel({ channel: 'iMessage', address: test.address })
          .pipe(test.signedIn)
        const saved = yield* (yield* ChannelStore).byPerson(test.actor.person.id, 'iMessage')
        if (Option.isNone(saved))
          return yield* Effect.sync(() => expect.fail('Missing enrolled link'))
        const disconnected = yield* channelHandlers
          .DisconnectChannel({ channel: 'iMessage' })
          .pipe(test.signedIn)
        expect(ChannelStanding.guards.NotConnected(disconnected.link.standing)).toBe(true)
        yield* channelHandlers.DisconnectChannel({ channel: 'iMessage' }).pipe(test.signedIn)
        expect(yield* Ref.get((yield* ChannelControl).unenrols)).toEqual([saved.value.enrolmentId])
        expect(
          Option.isNone(yield* (yield* ChannelStore).byAddress('iMessage', test.address)),
        ).toBe(true)
        return yield* Effect.void
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  it.effect('WatchChannels emits Connected after Connect and NotConnected after Disconnect', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(channelTestLayer)
      return yield* Effect.gen(function* () {
        const test = yield* fixture()
        const first = yield* Deferred.make<void>()
        const values = yield* Queue.unbounded<ChannelListResponse>()
        const fiber = yield* channelHandlers.WatchChannels().pipe(
          Stream.runForEach((value) =>
            Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
          ),
          test.signedIn,
          Effect.forkScoped,
        )
        yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
        const initial = yield* Queue.take(values)
        expect(initial.channels.map((link) => link.standing._tag)).toEqual([
          'NotConnected',
          'Unavailable',
        ])
        const receipt = yield* (yield* Changes).subscribe([Topic.person(test.actor.person.id)])
        const observation = { values, receipt, fiber }
        const next = () => nextValue(observation)
        yield* channelHandlers
          .ConnectChannel({ channel: 'iMessage', address: test.address })
          .pipe(test.signedIn)
        expect(firstChannel(yield* next()).standing._tag).toBe('Connected')
        yield* channelHandlers.DisconnectChannel({ channel: 'iMessage' }).pipe(test.signedIn)
        expect(firstChannel(yield* next()).standing._tag).toBe('NotConnected')
      }).pipe(Effect.scoped, Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
})
