import { Buffer } from 'node:buffer'
import { describe, expect, it } from '@effect/vitest'
import { DiscordAdapter } from '@chat-adapter/discord'
import { Effect, Fiber, Layer, Option, Predicate, Queue, Redacted, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { ChannelAddress } from '@vivid/contracts'
import { ChannelMessageId, ChannelProvider } from './provider.ts'
import { discordInbound, discordLayer } from './discord.ts'

const botId = '123456789012345678'
const DiscordReply = Schema.Struct({
  content: Schema.String,
  allowed_mentions: Schema.Struct({
    parse: Schema.Array(Schema.String),
    replied_user: Schema.Boolean,
  }),
  message_reference: Schema.optionalKey(
    Schema.Struct({ message_id: Schema.String, fail_if_not_exists: Schema.Boolean }),
  ),
})
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(DiscordReply), {
  onExcessProperty: 'error',
})
const adapter = new DiscordAdapter({
  botToken: 'test',
  applicationId: botId,
  webhookVerifier: () => false,
})
const message = (content: string, guild = false) =>
  adapter.parseMessage({
    id: '223456789012345678',
    channel_id: '323456789012345678',
    guild_id: guild ? '423456789012345678' : null,
    content,
    author: { id: '523456789012345678', username: 'person', bot: false },
    timestamp: '2026-10-26T12:00:00Z',
    edited_timestamp: null,
    attachments: [],
  })

describe('Discord message mapping', () => {
  it('maps every DM and an explicit guild mention to the original place', () => {
    const dm = message('123456')
    const first = discordInbound(botId, dm)
    expect(Option.getOrThrow(first)).toEqual({
      id: dm.id,
      channel: 'Discord',
      sender: 'discord:523456789012345678',
      text: '123456',
      receivedAt: Date.parse('2026-10-26T12:00:00Z'),
      place: { conversation: '323456789012345678', message: dm.id },
    })
    expect(Option.getOrThrow(discordInbound(botId, message('follow-up'))).text).toBe('follow-up')
    const mention = message(`<@!${botId}> **hello**`, true)
    mention.isMention = true
    expect(Option.getOrThrow(discordInbound(botId, mention)).text).toBe('**hello**')
    expect(Option.getOrThrow(discordInbound(botId, mention)).place).toEqual({
      conversation: '323456789012345678',
      message: mention.id,
    })
  })
  it('ignores bots, unmentioned guild messages and empty mentions', () => {
    const bot = message('hello')
    bot.author.isBot = true
    expect(Option.isNone(discordInbound(botId, bot))).toBe(true)
    expect(Option.isNone(discordInbound(botId, message('hello', true)))).toBe(true)
    const empty = message(`<@${botId}>`, true)
    empty.isMention = true
    expect(Option.isNone(discordInbound(botId, empty))).toBe(true)
  })
})

it.effect('sends bounded replies to the original place without mention parsing', () =>
  Effect.gen(function* () {
    const sent: Array<{ url: string; body: typeof DiscordReply.Type }> = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.method === 'POST' && Predicate.isTagged(request.body, 'Uint8Array'))
          sent.push({
            url: request.url,
            body: decodeReply(new TextDecoder().decode(request.body.body)),
          })
        return HttpClientResponse.fromWeb(request, Response.json({ id: botId }))
      }),
    )
    const context = yield* Layer.build(
      discordLayer(Redacted.make(`${Buffer.from(botId).toString('base64url')}.test.token`)).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    )
    const discord = yield* ChannelProvider.pipe(Effect.provide(context))
    const text = '@everyone <@&223456789012345678>'
    const place = {
      conversation: '323456789012345678',
      message: ChannelMessageId.make('423456789012345678'),
    }
    yield* discord.send({
      channel: 'Discord',
      address: ChannelAddress.make('discord:523456789012345678'),
      text,
      place,
    })
    expect(sent).toEqual([
      {
        url: 'https://discord.com/api/v10/channels/323456789012345678/messages',
        body: {
          content: text,
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: { message_id: place.message, fail_if_not_exists: false },
        },
      },
    ])
    yield* discord.send({
      channel: 'Discord',
      address: ChannelAddress.make('discord:523456789012345678'),
      text: 'x'.repeat(2100),
      place,
    })
    expect(sent.slice(1).map((entry) => entry.body)).toEqual(
      [2000, 100].map((length) => ({
        content: 'x'.repeat(length),
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: place.message, fail_if_not_exists: false },
      })),
    )
  }).pipe(Effect.scoped),
)

it.effect(
  'retries chunk 2 once after Discord rate limits and preserves partial-send classification',
  () =>
    Effect.gen(function* () {
      for (const mode of ['body', 'header', 'repeated'] as const) {
        const sent: string[] = []
        const limited = yield* Queue.unbounded<void>()
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.method !== 'POST' || !Predicate.isTagged(request.body, 'Uint8Array'))
              return HttpClientResponse.fromWeb(request, Response.json({ id: botId }))
            const body = decodeReply(new TextDecoder().decode(request.body.body))
            sent.push(body.content)
            if (sent.length === 2 || (mode === 'repeated' && sent.length === 3)) {
              Queue.offerUnsafe(limited, undefined)
              return HttpClientResponse.fromWeb(
                request,
                mode === 'header'
                  ? Response.json({}, { status: 429, headers: { 'Retry-After': '2' } })
                  : Response.json({ retry_after: 2 }, { status: 429 }),
              )
            }
            return HttpClientResponse.fromWeb(request, Response.json({ id: botId }))
          }),
        )
        const context = yield* Layer.build(
          discordLayer(
            Redacted.make(`${Buffer.from(botId).toString('base64url')}.test.token`),
          ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        )
        const discord = yield* ChannelProvider.pipe(Effect.provide(context))
        const sending = yield* discord
          .send({
            channel: 'Discord',
            address: ChannelAddress.make('discord:523456789012345678'),
            text: 'a'.repeat(2000) + 'b'.repeat(2000) + 'c',
            place: {
              conversation: '323456789012345678',
              message: ChannelMessageId.make('423456789012345678'),
            },
          })
          .pipe(Effect.result, Effect.forkScoped)
        yield* Queue.take(limited)
        expect(sent).toEqual(['a'.repeat(2000), 'b'.repeat(2000)])
        yield* TestClock.adjust('1 second')
        expect(sent).toHaveLength(2)
        yield* TestClock.adjust('1 second')
        const result = yield* Fiber.join(sending)
        expect(sent).toEqual(
          mode === 'repeated'
            ? ['a'.repeat(2000), 'b'.repeat(2000), 'b'.repeat(2000)]
            : ['a'.repeat(2000), 'b'.repeat(2000), 'b'.repeat(2000), 'c'],
        )
        if (mode === 'repeated')
          expect(Result.isFailure(result) ? result.failure._tag : 'sent').toBe('ChannelSendUnknown')
        else expect(Result.isSuccess(result)).toBe(true)
      }
    }).pipe(Effect.scoped),
)
