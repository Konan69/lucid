import {
  ChannelUnavailable,
  ChannelProviderFailed,
  type Channel,
  type ChannelAddress,
} from '@vivid/contracts'
import { Config, Effect, Filter, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { Spectrum, type Message, type Space } from 'spectrum-ts'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { imessage } from 'spectrum-ts/providers/imessage'
import { normalizeChannelAddress } from './address.ts'
import {
  ChannelEnrolment,
  type ChannelEnrolmentId,
  ChannelDisconnected,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
  ChannelRecipientMissing,
  ChannelSendUnknown,
  InvalidChannelMessage,
  unavailableChannelProviderLayer,
} from './provider.ts'

/** Stable create-user returns the existing active shared user when its phone is already enrolled. */
const Created = Schema.Struct({
  succeed: Schema.Literal(true),
  data: Schema.Struct({
    id: ChannelEnrolment.fields.id,
    assignedPhoneNumber: ChannelEnrolment.fields.textTo,
  }),
})
const Create = Schema.Struct({
  type: Schema.Literal('shared'),
  phoneNumber: ChannelEnrolment.fields.textTo,
})
const Deleted = Schema.Struct({
  succeed: Schema.Literal(true),
  data: Schema.Struct({ userId: Schema.NonEmptyString }),
})

interface PhotonCredentials {
  readonly projectId: string
  readonly projectSecret: Redacted.Redacted
}

/**
 * Stable docs api-reference/users/{create-user,delete-user}: Basic auth, assignedPhoneNumber,
 * idempotent shared-phone creation, soft deletion by user id. Spectrum 12.10.1 exports no user
 * enrolment operation; this HTTP adapter owns that independent project-management boundary.
 * No retry: transport failure may have enrolled the number, and a later Connect uses the API's
 * documented idempotency. Stable docs do not specify the maxSharedUsers error envelope/status;
 * until proven, refusals remain ProviderFailed rather than guessing that rate limits are plan limits.
 */
const makeEnrolment = Effect.fn('Channels.makeEnrolment')(function* (config: PhotonCredentials) {
  const client = yield* HttpClient.HttpClient
  const base = `https://spectrum.photon.codes/projects/${encodeURIComponent(config.projectId)}/users/`
  const authenticate = HttpClientRequest.basicAuth(config.projectId, config.projectSecret)
  const failed = (channel: Channel) => new ChannelProviderFailed({ channel })

  /** Decode only the documented successful envelope; private provider payloads never leave this adapter. */
  const enrol = Effect.fn('Channels.enrolPhoton')(function* (
    channel: Channel,
    address: ChannelAddress,
  ) {
    if (channel !== 'iMessage') return yield* new ChannelUnavailable({ channel })
    const request = yield* HttpClientRequest.schemaBodyJson(Create)(HttpClientRequest.post(base), {
      type: 'shared',
      phoneNumber: address,
    }).pipe(Effect.mapError(() => failed(channel)))
    const response = yield* client
      .execute(authenticate(request))
      .pipe(Effect.mapError(() => failed(channel)))
    if (response.status !== 200) return yield* failed(channel)
    const created = yield* HttpClientResponse.schemaBodyJson(Created)(response).pipe(
      Effect.mapError(() => failed(channel)),
    )
    return ChannelEnrolment.make({ id: created.data.id, textTo: created.data.assignedPhoneNumber })
  })

  /** A missing user is already disconnected; all other refusals retain the local link for retry. */
  const unenrol = Effect.fn('Channels.unenrolPhoton')(function* (
    channel: Channel,
    id: ChannelEnrolmentId,
  ) {
    if (channel !== 'iMessage') return yield* new ChannelUnavailable({ channel })
    const response = yield* client
      .execute(authenticate(HttpClientRequest.delete(`${base}${encodeURIComponent(id)}/`)))
      .pipe(Effect.mapError(() => failed(channel)))
    if (response.status === 404) return yield* Effect.void
    if (response.status !== 200) return yield* failed(channel)
    return yield* HttpClientResponse.schemaBodyJson(Deleted)(response).pipe(
      Effect.mapError(() => failed(channel)),
      Effect.asVoid,
    )
  })
  return { enrol, unenrol }
})

/** The SDK may emit actor-less control events; only private inbound envelopes enter linking. */
const Envelope = Schema.Struct({
  id: ChannelMessageId,
  platform: Schema.Literal('imessage'),
  direction: Schema.Literal('inbound'),
  sender: Schema.Struct({ id: Schema.String }),
  timestamp: Schema.Date,
  content: Schema.Struct({ type: Schema.Literal('text'), text: Schema.NonEmptyString }),
})
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

const disconnected = () => new ChannelDisconnected({ channel: 'iMessage' })
const invalidMessage = () => new InvalidChannelMessage({ channel: 'iMessage' })

/** Acquire only while the stream is consumed; merely listing channel addresses does no I/O. */
const connectPhoton = Effect.fn('Channels.connectPhoton')((config: PhotonCredentials) =>
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

/** Refuse malformed SDK envelopes without retaining their address, text, or decoder issue. */
const refuseEnvelope = Effect.fn('Channels.refuseEnvelope')(() =>
  Effect.logWarning('iMessage envelope refused').pipe(Effect.as(Option.none<ChannelInbound>())),
)

/**
 * Installed Spectrum 12.10.1 Space.send has no caller idempotency key. The iMessage
 * lifecycle.createClient enables autoIdempotency for one unary attempt's retries; a new send
 * after a crash gets a new key, so recovery must not resend.
 *
 * Diagnostics/telemetry are disabled to preserve Vivid's content logging policy. Original
 * inbound Spaces retain reply routing: shared hosted lines expose neither a recipient nor
 * a from selector (iMessage types.SHARED_PHONE), so creating a chat could pick another line.
 */
const makePhoton = Effect.fn('Channels.makePhoton')(function* (config: PhotonCredentials) {
  const enrolment = yield* makeEnrolment(config)
  const spaces = new Map<string, Space>()
  const clearSpaces = Effect.sync(() => spaces.clear())
  /** Decode SDK input once; only a validated sender may retain a private reply handle. */
  const receive = Effect.fn('Channels.decodePhoton')(
    function* ([space, message]: [Space, Message]) {
      const envelope = yield* decodeEnvelope(message).pipe(Effect.mapError(invalidMessage))
      const sender = yield* normalizeChannelAddress({
        channel: 'iMessage',
        value: envelope.sender.id,
      })
      spaces.set(sender, space)
      return Option.some(
        ChannelInbound.make({
          id: envelope.id,
          channel: 'iMessage',
          sender,
          text: envelope.content.text,
          receivedAt: envelope.timestamp.getTime(),
        }),
      )
    },
    (effect) =>
      effect.pipe(
        Effect.catchTag(['InvalidChannelMessage', 'InvalidChannelAddress'], refuseEnvelope),
      ),
  )
  /**
   * core/types/message.ts and imessage/message.ts (12.10.1) also expose groups, attachments,
   * reactions, edits and controls. Ignore them before decoding; retain no stale Space on reconnect.
   */
  const connect = Effect.fn('Channels.streamPhoton')(function* () {
    const application = yield* Effect.acquireRelease(connectPhoton(config), closePhoton)
    yield* Effect.addFinalizer(() => clearSpaces)
    return Stream.fromAsyncIterable(application.messages, disconnected).pipe(
      Stream.filter(
        ([space, message]) =>
          space.__platform === 'imessage' &&
          message.direction === 'inbound' &&
          message.content.type === 'text' &&
          message.content.text.trim().length > 0 &&
          'type' in space &&
          space.type === 'dm',
      ),
      Stream.mapEffect(receive),
      Stream.filterMap(Filter.fromPredicateOption((value) => value)),
    )
  })
  return ChannelProvider.of({
    available: (channel) => channel === 'iMessage',
    enrol: (channel, address) => enrolment.enrol(channel, address),
    unenrol: (channel, id) => enrolment.unenrol(channel, id),
    inbound: Stream.unwrap(connect()),
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
    if (Option.isNone(projectId) || Option.isNone(projectSecret))
      return unavailableChannelProviderLayer
    const credentials = { projectId: projectId.value, projectSecret: projectSecret.value }
    return Layer.effect(ChannelProvider, makePhoton(credentials))
  }),
)
