import * as NodeBuffer from 'node:buffer'
import { describe, expect, it } from '@effect/vitest'
import { ChannelAddress, ChannelUnavailable, type Channel } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Result, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http'
import { channelProviderLayer, combineChannels } from './combined.ts'
import {
  ChannelDisconnected,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
} from './provider.ts'

const message = ChannelInbound.make({
  id: ChannelMessageId.make('message'),
  channel: 'Discord',
  sender: ChannelAddress.make('discord:523456789012345678'),
  text: 'hello',
  receivedAt: 0,
})
const provider = (
  channel: Channel,
  inbound: ChannelProvider['Service']['inbound'],
  sends: string[],
) =>
  ChannelProvider.of({
    channels: [channel],
    codeAddress: () => Option.none(),
    enrol: () => Effect.fail(new ChannelUnavailable({ channel })),
    unenrol: () => Effect.void,
    inbound,
    send: () =>
      Effect.sync(() => {
        sends.push(channel)
      }),
  })

describe('channel composition', () => {
  it.effect('composes the Photon provider when the Discord token is unset', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        channelProviderLayer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIVID_PHOTON_PROJECT_ID: 'test',
                VIVID_PHOTON_PROJECT_SECRET: 'test',
              }),
            ),
          ),
        ),
      )
      expect((yield* ChannelProvider.pipe(Effect.provide(context))).channels).toEqual(['iMessage'])
    }).pipe(Effect.scoped),
  )
  it.effect(
    'composes without Discord network I/O and keeps Photon usable during Discord 503s',
    () =>
      Effect.gen(function* () {
        const discordRequests: string[] = []
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.startsWith('https://discord.com')) {
              discordRequests.push(request.url)
              return HttpClientResponse.fromWeb(request, new Response('', { status: 503 }))
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                succeed: true,
                data: { id: 'photon-enrolment', assignedPhoneNumber: '+12025550100' },
              }),
            )
          }),
        )
        const context = yield* Layer.build(
          channelProviderLayer.pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  VIVID_PHOTON_PROJECT_ID: 'test',
                  VIVID_PHOTON_PROJECT_SECRET: 'test',
                  VIVID_DISCORD_BOT_TOKEN: `${NodeBuffer.Buffer.from('123456789012345678').toString('base64url')}.test.token`,
                }),
              ),
            ),
          ),
        )
        const combined = yield* ChannelProvider.pipe(Effect.provide(context))
        expect(Option.getOrThrow(combined.codeAddress('Discord'))).toBe(
          'discord:123456789012345678',
        )
        expect(discordRequests).toEqual([])
        expect((yield* combined.enrol('iMessage', ChannelAddress.make('+12025550123'))).id).toBe(
          'photon-enrolment',
        )
      }).pipe(Effect.scoped),
  )

  it.effect('rejects malformed Discord tokens at the setting boundary without exposing them', () =>
    Effect.gen(function* () {
      for (const token of [
        'invalid-token',
        `${NodeBuffer.Buffer.from('not-a-snowflake').toString('base64url')}.test.token`,
      ]) {
        const result = yield* Layer.build(
          channelProviderLayer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  VIVID_PHOTON_PROJECT_ID: 'test',
                  VIVID_PHOTON_PROJECT_SECRET: 'test',
                  VIVID_DISCORD_BOT_TOKEN: token,
                }),
              ),
            ),
          ),
        ).pipe(Effect.result)
        expect(Result.isFailure(result) ? result.failure._tag : 'composed').toBe(
          'ConfigurationError',
        )
        expect(JSON.stringify(result)).not.toContain(token)
      }
    }).pipe(Effect.scoped),
  )

  it.effect(
    'keeps the other inbound stream alive during a disconnect and routes sends by channel',
    () =>
      Effect.gen(function* () {
        const sends: string[] = []
        const combined = combineChannels([
          provider(
            'iMessage',
            Stream.fail(new ChannelDisconnected({ channel: 'iMessage' })),
            sends,
          ),
          provider('Discord', Stream.make(message).pipe(Stream.concat(Stream.never)), sends),
        ])
        expect(yield* combined.inbound.pipe(Stream.take(1), Stream.runCollect)).toEqual([message])
        for (const channel of ['iMessage', 'Discord'] satisfies ReadonlyArray<Channel>)
          yield* combined.send({ channel, address: message.sender, text: 'reply' })
        expect(sends).toEqual(['iMessage', 'Discord'])
      }).pipe(Effect.scoped),
  )
})
