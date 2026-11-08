import * as NodeBuffer from 'node:buffer'
import { DiscordAdapter } from '@chat-adapter/discord'
import { createMemoryState } from '@chat-adapter/state-memory'
import { ChannelAddress, ChannelUnavailable } from '@vivid/contracts'
import { Chat, ConsoleLogger, type Message, type Thread } from 'chat'
import { Cause, Effect, Layer, Option, Queue, Redacted, Schema, Stream, type Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  ChannelDisconnected,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
  ChannelRecipientMissing,
  ChannelSendUnknown,
} from './provider.ts'
import { ChannelTextLimit, splitChannelText } from './text.ts'
import { settingText } from '../config.ts'

export const discordToken = Schema.RedactedFromValue(
  settingText.check(
    Schema.makeFilter((token) => {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return false
      const id = NodeBuffer.Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')
      return /^[1-9][0-9]{16,19}$/u.test(id) && BigInt(id) <= 18446744073709551615n
    }),
  ),
)
const RateLimit = Schema.Struct({
  retry_after: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
})
const RetryAfter = Schema.NumberFromString.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
)
const decodeRetryAfter = Schema.decodeUnknownOption(RetryAfter)
const RawMessage = Schema.Struct({ channel_id: Schema.NonEmptyString, content: Schema.String })
const decodeRaw = Schema.decodeUnknownOption(RawMessage)

export const discordInbound = (botId: string, message: Message): Option.Option<ChannelInbound> => {
  if (message.author.isBot || message.author.isMe) return Option.none()
  const dm = message.threadId.startsWith('discord:@me:')
  if (!dm && message.isMention !== true) return Option.none()
  const raw = decodeRaw(message.raw)
  if (Option.isNone(raw)) return Option.none()
  const text = raw.value.content.replace(new RegExp(`<@!?${botId}>`, 'gu'), '').trim()
  const receivedAt = message.metadata.dateSent.getTime()
  if (text.length === 0 || !Number.isFinite(receivedAt)) return Option.none()
  const id = ChannelMessageId.make(message.id)
  return Option.some(
    ChannelInbound.make({
      id,
      channel: 'Discord',
      sender: ChannelAddress.make(`discord:${message.author.userId}`),
      text,
      receivedAt,
      place: { conversation: raw.value.channel_id, message: id },
    }),
  )
}

class VividDiscord extends DiscordAdapter {
  // The SDK's default hook creates a thread before dispatching every mention, even from unlinked users.
  protected override handleGatewayMessage(
    message: Parameters<DiscordAdapter['handleGatewayMessage']>[0],
    _isMentioned: boolean,
  ): Promise<void> {
    const mentioned = this.botUserId !== undefined && message.mentions.users.has(this.botUserId)
    if (message.author.bot || (message.guildId !== null && !mentioned)) return Promise.resolve()
    const parsed = this.parseMessage({
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      content: message.content,
      author: { id: message.author.id, username: message.author.username, bot: message.author.bot },
      timestamp: message.createdAt.toISOString(),
      edited_timestamp: null,
      attachments: [],
    })
    parsed.isMention = mentioned
    if (this.chat === null) return Promise.resolve()
    return this.chat.processMessage(this, parsed.threadId, parsed, { deduplicate: false })
  }
}

const disconnected = () => new ChannelDisconnected({ channel: 'Discord' })
const recipientMissing = () => new ChannelRecipientMissing({ channel: 'Discord' })
const textLimit = ChannelTextLimit.make(2000)

/** Each inbound subscription owns its gateway listener and both scoped forwarding fibers. */
const discordStream = (
  discord: VividDiscord,
  incoming: Queue.Queue<ChannelInbound | 'Connected'>,
  connect: Effect.Effect<void, ChannelDisconnected, Scope.Scope>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* connect
      const events = yield* Queue.unbounded<ChannelInbound, ChannelDisconnected>()
      // The SDK requires a bounded listener; discord.js resumes the socket within one span.
      // A short span would end quiet periods through the worker's growing backoff and drop
      // messages sent in the gap, so one span lasts a day.
      yield* Effect.tryPromise({
        try: (signal) => {
          let completion = Promise.resolve<unknown>(undefined)
          return discord
            .startGatewayListener(
              {
                waitUntil: (task) => {
                  completion = task
                },
              },
              86_400_000,
              signal,
            )
            .then(() => completion)
        },
        catch: disconnected,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => Queue.failCauseUnsafe(events, Cause.fail(disconnected()))),
        ),
        Effect.forkScoped,
      )
      yield* Stream.fromQueue(incoming).pipe(
        Stream.runForEach((message) =>
          message === 'Connected'
            ? Effect.logInfo('Discord channel connected')
            : Queue.offer(events, message),
        ),
        Effect.forkScoped,
      )
      return Stream.fromQueue(events)
    }),
  )

/** Replies preserve the original place, mention suppression, chunking and failure classification. */
const discordSend = (
  discord: VividDiscord,
  request: HttpClient.HttpClient['execute'],
  base: string,
) => {
  const post = Effect.fn('Channels.discordPost')(function* (
    path: string,
    body: {
      readonly content: string
      readonly allowed_mentions: {
        readonly parse: ReadonlyArray<never>
        readonly replied_user: false
      }
      readonly message_reference?: {
        readonly message_id: string
        readonly fail_if_not_exists: false
      }
    },
  ) {
    const send = HttpClientRequest.bodyJson(HttpClientRequest.post(`${base}${path}`), body).pipe(
      Effect.flatMap(request),
    )
    const response = yield* send
    if (response.status !== 429) return response
    const retry = yield* HttpClientResponse.schemaBodyJson(RateLimit)(response).pipe(
      Effect.map((limit) => Option.some(limit.retry_after)),
      Effect.orElseSucceed(() => decodeRetryAfter(response.headers['retry-after'])),
    )
    if (Option.isNone(retry)) return response
    yield* Effect.sleep(retry.value * 1000)
    return yield* send
  })
  return Effect.fn('Channels.discordSend')(function* (
    input: Parameters<ChannelProvider['Service']['send']>[0],
  ) {
    if (input.channel !== 'Discord')
      return yield* new ChannelUnavailable({ channel: input.channel })
    let conversation = input.place === undefined ? undefined : input.place.conversation
    if (conversation === undefined) {
      const thread = yield* Effect.tryPromise({
        try: () => discord.openDM(input.address.slice('discord:'.length)),
        catch: recipientMissing,
      })
      conversation = discord.decodeThreadId(thread).channelId
    }
    let sent = false
    for (const content of splitChannelText(input.text, textLimit)) {
      const body = {
        content,
        allowed_mentions: { parse: [], replied_user: false },
      } satisfies Parameters<typeof post>[1]
      const response = yield* post(
        `/channels/${encodeURIComponent(conversation)}/messages`,
        input.place === undefined
          ? body
          : {
              ...body,
              message_reference: { message_id: input.place.message, fail_if_not_exists: false },
            },
      ).pipe(Effect.mapError(() => new ChannelSendUnknown({ channel: 'Discord' })))
      if (response.status === 429)
        return yield* sent ? new ChannelSendUnknown({ channel: 'Discord' }) : recipientMissing()
      if (response.status >= 400 && response.status < 500) return yield* recipientMissing()
      if (response.status < 200 || response.status >= 300)
        return yield* new ChannelSendUnknown({ channel: 'Discord' })
      sent = true
    }
    return yield* Effect.void
  })
}

const makeDiscord = Effect.fn('Channels.makeDiscord')(function* (token: Redacted.Redacted) {
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn('Channels.discordRequest')(
    (input: HttpClientRequest.HttpClientRequest) =>
      client.execute(
        HttpClientRequest.setHeader(input, 'Authorization', `Bot ${Redacted.value(token)}`),
      ),
  )
  const base = 'https://discord.com/api/v10'
  const botId = NodeBuffer.Buffer.from(
    Redacted.value(token).split('.')[0] ?? '',
    'base64url',
  ).toString('utf8')
  const address = ChannelAddress.make(`discord:${botId}`)
  const incoming = yield* Queue.unbounded<ChannelInbound | 'Connected'>()
  const logger = new ConsoleLogger('silent')
  logger.info = (message) => {
    if (message === 'Discord Gateway connected') Queue.offerUnsafe(incoming, 'Connected')
  }
  const discord = new VividDiscord({
    botToken: Redacted.value(token),
    applicationId: botId,
    apiUrl: base,
    // No webhook endpoint is exposed by this resident adapter.
    webhookVerifier: () => false,
    mentionRoleIds: [],
    respondToChannelIds: [],
    respondToGlobalMentions: false,
    logger,
  })
  const bot = new Chat({
    userName: 'vivid',
    adapters: { discord },
    state: createMemoryState(),
    concurrency: 'concurrent',
    logger: 'silent',
  })
  const receive = (_thread: Thread, message: Message) => {
    const mapped = discordInbound(botId, message)
    if (Option.isSome(mapped)) Queue.offerUnsafe(incoming, mapped.value)
    return Promise.resolve()
  }
  bot.onNewMention(receive)
  bot.onDirectMessage(receive)
  const connect = Effect.addFinalizer(() => Effect.promise(() => bot.shutdown())).pipe(
    Effect.andThen(Effect.tryPromise({ try: () => bot.initialize(), catch: disconnected })),
  )
  return ChannelProvider.of({
    channels: ['Discord'],
    codeAddress: (channel) => (channel === 'Discord' ? Option.some(address) : Option.none()),
    enrol: (channel) => Effect.fail(new ChannelUnavailable({ channel })),
    unenrol: (channel) =>
      channel === 'Discord' ? Effect.void : Effect.fail(new ChannelUnavailable({ channel })),
    inbound: discordStream(discord, incoming, connect),
    send: discordSend(discord, request, base),
  })
})

export const discordLayer = (token: Redacted.Redacted) =>
  Layer.effect(ChannelProvider, makeDiscord(token))
