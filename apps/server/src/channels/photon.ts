import { ChannelUnavailable, type ChannelAddress } from '@vivid/contracts'
import { Config, Effect, Filter, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { Spectrum, type Message, type Space } from 'spectrum-ts'
import { imessage } from 'spectrum-ts/providers/imessage'
import { normalizeChannelAddress } from './address.ts'
import {
  ChannelContent,
  ChannelDisconnected,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
  ChannelRecipientMissing,
  ChannelSendUnknown,
  InvalidChannelMessage,
  unavailableChannelProviderLayer,
} from './provider.ts'

/** An open provider content vocabulary never implies support for a new SDK kind. */
const ProviderContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.String.check(Schema.makeFilter((type) => type !== 'text')) }),
])

/** The SDK may emit actor-less control events; only private inbound envelopes enter linking. */
const Envelope = Schema.Struct({
  id: ChannelMessageId,
  platform: Schema.Literal('imessage'),
  direction: Schema.Literal('inbound'),
  sender: Schema.Struct({ id: Schema.String }),
  timestamp: Schema.Date,
  content: ProviderContent,
})
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

/**
 * Installed Spectrum 12.10.1 core Message/Content exposes text, grouped multipart content,
 * attachments, reactions, edits and controls. Only plain Text is admitted; groups (including
 * mixed attachments/text), markdown, replies and every other kind receive Unsupported.
 */
const contentOf = (content: typeof ProviderContent.Type): ChannelContent =>
  'text' in content && content.text.trim().length > 0
    ? ChannelContent.cases.Text.make({ text: content.text })
    : ChannelContent.cases.Unsupported.make({})

interface PhotonConfiguration {
  readonly projectId: string
  readonly projectSecret: Redacted.Redacted
  readonly ownAddress: string
}

const disconnected = () => new ChannelDisconnected({ channel: 'iMessage' })
const invalidMessage = () => new InvalidChannelMessage({ channel: 'iMessage' })

/** Acquire only while the stream is consumed; merely listing channel addresses does no I/O. */
const connectPhoton = Effect.fn('Channels.connectPhoton')((config: PhotonConfiguration) =>
  Effect.tryPromise({
    try: () =>
      Spectrum({
        providers: [imessage.config({})],
        projectId: config.projectId,
        projectSecret: Redacted.value(config.projectSecret),
        telemetry: false,
        options: { logLevel: 'silent', flattenGroups: false },
      }),
    catch: disconnected,
  }),
)

type PhotonApplication = Effect.Success<ReturnType<typeof connectPhoton>>

/** SDK stop cascades iterator cancellation and closes provider clients; a cleanup failure cannot leak content. */
const closePhoton = Effect.fn('Channels.closePhoton')((application: PhotonApplication) =>
  Effect.tryPromise({ try: () => application.stop(), catch: disconnected }).pipe(
    Effect.catchTag('ChannelDisconnected', () =>
      Effect.logError('iMessage connection cleanup failed'),
    ),
  ),
)

/** Refuse actor-less or malformed envelopes individually so one control event cannot end the connection. */
const decodePhoton = Effect.fn('Channels.decodePhoton')(
  function* (message: Message) {
    const envelope = yield* decodeEnvelope(message).pipe(Effect.mapError(invalidMessage))
    const sender = yield* normalizeChannelAddress({
      channel: 'iMessage',
      value: envelope.sender.id,
    })
    return Option.some(
      ChannelInbound.make({
        id: envelope.id,
        channel: 'iMessage',
        sender,
        content: contentOf(envelope.content),
        receivedAt: envelope.timestamp.getTime(),
      }),
    )
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(['InvalidChannelMessage', 'InvalidChannelAddress'], (error) =>
        Effect.logWarning('iMessage envelope refused', { reason: error._tag }).pipe(
          Effect.as(Option.none<ChannelInbound>()),
        ),
      ),
    ),
)

/** Only successfully decoded identities may retain a private reply handle. */
const routePhoton = Effect.fn('Channels.routePhoton')(function* (input: {
  readonly pair: [Space, Message]
  readonly spaces: Map<string, Space>
}) {
  const [space, message] = input.pair
  const decoded = yield* decodePhoton(message)
  if (Option.isSome(decoded)) input.spaces.set(decoded.value.sender, space)
  return decoded
})

/**
 * Installed Spectrum 12.10.1 Space.send has no caller idempotency key. The iMessage
 * lifecycle.createClient enables autoIdempotency for one unary attempt's retries; a new send
 * after a crash gets a new key, so recovery must not resend.
 *
 * Diagnostics/telemetry are disabled to preserve Vivid's content logging policy. Original
 * inbound Spaces retain reply routing: shared hosted lines expose neither a recipient nor
 * a from selector (iMessage types.SHARED_PHONE), so creating a chat could pick another line.
 */
const makePhoton = Effect.fn('Channels.makePhoton')(function* (config: PhotonConfiguration) {
  const ownAddress = yield* normalizeChannelAddress({
    channel: 'iMessage',
    value: config.ownAddress,
  })
  const spaces = new Map<string, Space>()
  const clearSpaces = Effect.sync(() => spaces.clear())
  /** Keep routing handles only for this live connection; stale handles never survive reconnection. */
  const connect = Effect.fn('Channels.streamPhoton')(function* () {
    const application = yield* Effect.acquireRelease(connectPhoton(config), closePhoton)
    yield* Effect.addFinalizer(() => clearSpaces)
    return Stream.fromAsyncIterable(application.messages, disconnected).pipe(
      Stream.filter(
        ([space, message]) =>
          space.__platform === 'imessage' &&
          message.direction === 'inbound' &&
          'type' in space &&
          space.type === 'dm',
      ),
      Stream.mapEffect((pair) => routePhoton({ pair, spaces })),
      Stream.filterMap(Filter.fromPredicateOption((value) => value)),
    )
  })
  return ChannelProvider.of({
    address: Effect.fn('Channels.photonAddress')(function* (channel): Effect.fn.Return<
      ChannelAddress,
      ChannelUnavailable
    > {
      if (channel !== 'iMessage') return yield* new ChannelUnavailable({ channel })
      return ownAddress
    }),
    inbound: Stream.unwrap(connect()),
    idempotentSends: false,
    send: Effect.fn('Channels.photonSend')(function* (input) {
      if (input.channel !== 'iMessage')
        return yield* new ChannelUnavailable({ channel: input.channel })
      const space = spaces.get(input.address)
      if (space === undefined) return yield* new ChannelRecipientMissing({ channel: input.channel })
      return yield* Effect.tryPromise({
        try: () => space.send(input.text),
        catch: () => new ChannelSendUnknown({ channel: input.channel, key: input.key }),
      }).pipe(Effect.asVoid)
    }),
  })
})

/** No credentials acquires no SDK/network resource; a partially configured Integration is unavailable. */
export const photonLayer = Layer.unwrap(
  Effect.gen(function* () {
    const projectId = yield* Config.option(Config.String('VIVID_PHOTON_PROJECT_ID'))
    const projectSecret = yield* Config.option(Config.Redacted('VIVID_PHOTON_PROJECT_SECRET'))
    const ownAddress = yield* Config.option(Config.String('VIVID_PHOTON_IMESSAGE_ADDRESS'))
    if (Option.isNone(projectId) || Option.isNone(projectSecret) || Option.isNone(ownAddress))
      return unavailableChannelProviderLayer
    return Layer.effect(
      ChannelProvider,
      makePhoton({
        projectId: projectId.value,
        projectSecret: projectSecret.value,
        ownAddress: ownAddress.value,
      }),
    )
  }),
)
