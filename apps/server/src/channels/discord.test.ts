import { describe, expect, it } from '@effect/vitest'
import { DiscordAdapter } from '@chat-adapter/discord'
import { Effect, Layer, Option, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { ChannelAddress } from '@vivid/contracts'
import { ChannelMessageId, ChannelProvider } from './provider.ts'
import { discordInbound, discordLayer } from './discord.ts'

const botId = '123456789012345678'
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
    const sent: Array<{ url: string; body: unknown }> = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.method === 'POST' && request.body._tag === 'Uint8Array')
          sent.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)),
          })
        return HttpClientResponse.fromWeb(request, Response.json({ id: botId }))
      }),
    )
    const context = yield* Layer.build(
      discordLayer(Redacted.make('test-token')).pipe(
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
