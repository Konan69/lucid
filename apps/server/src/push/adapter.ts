// web-push is CommonJS whose exports Node's loader cannot name, so under `tsx` (how the server
// runs) a namespace import has no `generateRequestDetails`; the default import is its exports.
import WebPush from 'web-push'
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  NotificationOpens,
  PUSH_CATEGORY,
  PushAsk,
  PushDestination,
  PushPayload,
} from '@vivid/contracts'
import { PushConfig } from './config.ts'
import {
  PushAcceptance,
  PushRejected,
  PushTargetGone,
  PushUncertain,
  type PushSendError,
} from './receipts.ts'

/** Only the network/cryptography seam is substituted in tests; the ledger and sessions stay real. */
export interface PushAdapterService {
  readonly send: (
    destination: PushDestination,
    payload: PushPayload,
  ) => Effect.Effect<PushAcceptance, PushSendError>
  readonly receipt: (
    ticket: string,
  ) => Effect.Effect<Option.Option<'Confirmed' | 'Gone' | 'Rejected'>, PushRejected | PushUncertain>
}
export class PushAdapter extends Context.Service<PushAdapter, PushAdapterService>()(
  'vivid/PushAdapter',
) {}

/** Bounds how long a browser provider retains an undelivered Run notice.
 * Source: unmeasured. Expiry drops stale delivery; the persisted Notification stays readable. */
const BROWSER_RETENTION_SECONDS = 3600
/** Bounds one external acceptance or receipt exchange, including body decoding. No provider
 * completion push exists for a stalled HTTP exchange. Source: unmeasured. Expiry returns
 * PushUncertain, preserving the non-repeatable send claim. */
const PUSH_EXCHANGE_LIMIT = '10 seconds'

const ExpoResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('ok'), id: Schema.NonEmptyString }),
  Schema.Struct({
    status: Schema.Literal('error'),
    details: Schema.optionalKey(Schema.Struct({ error: Schema.String })),
  }),
]).pipe(Schema.toTaggedUnion('status'))
const ExpoResponse = Schema.Struct({ data: ExpoResult })
const ExpoReceipt = Schema.Union([
  Schema.Struct({ status: Schema.Literal('ok') }),
  ExpoResult.cases.error,
]).pipe(Schema.toTaggedUnion('status'))
const ExpoReceipts = Schema.Struct({ data: Schema.Record(Schema.String, ExpoReceipt) })
const ExpoMessage = Schema.Struct({
  to: PushDestination.cases.Phone.fields.token,
  title: Schema.String,
  body: Schema.String,
  // Expo plays the system sound for 'default' and none for null; on Android the channel decides,
  // so a quiet notice also names the phone's quiet channel (`apps/mobile/src/data/notifying.ts`).
  sound: Schema.NullOr(Schema.Literal('default')),
  channelId: Schema.Literals(['default', 'quiet'] as const),
  data: PushPayload,
  mutableContent: Schema.Boolean,
  threadId: Schema.String,
  // The buttons the phone shows (`PUSH_CATEGORY`); absent on a notice that asks nothing.
  categoryId: Schema.optionalKey(
    Schema.Literals([
      PUSH_CATEGORY.Approval,
      PUSH_CATEGORY.Draft,
      'vivid.thread',
      'vivid.notice',
    ] as const),
  ),
})
const ReceiptRequest = Schema.Struct({ ids: Schema.Array(Schema.String) })
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(PushPayload))

/** 404/410 revoke Web Push authority; other refusals never authorize an uncertain retry. */
const acceptedStatus = (status: number) => {
  if (status === 404 || status === 410) return Effect.fail(new PushTargetGone({}))
  if (status < 200 || status >= 300) return Effect.fail(new PushRejected({}))
  return Effect.void
}

/**
 * Uses web-push 3.6.7's public generateRequestDetails for RFC 8291 encryption/VAPID, and Effect
 * HttpClient.withScope for cancellable I/O: the operation Scope releases status-only replies.
 * No mutable SDK singleton, raw Promise or credential logging.
 */
const sendBrowser = Effect.fn('PushAdapter.browser')(function* (
  destination: typeof PushDestination.cases.Browser.Type,
  payload: PushPayload,
) {
  const config = yield* PushConfig
  // A payload that will not encode was never handed to the provider: refused, with no retry owed.
  const body = yield* encodePayload(payload).pipe(Effect.mapError(() => new PushRejected({})))
  const details = yield* Effect.try({
    try: () =>
      WebPush.generateRequestDetails(destination, body, {
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: Redacted.value(config.privateKey),
        },
        TTL: BROWSER_RETENTION_SECONDS,
        contentEncoding: 'aes128gcm',
      }),
    catch: () => new PushRejected({}),
  })
  if (details.body === null) return yield* new PushRejected({})
  // The exchange Scope owns this response and aborts whatever the caller leaves unread.
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client
    .execute(
      HttpClientRequest.post(details.endpoint).pipe(
        HttpClientRequest.bodyUint8Array(details.body),
        HttpClientRequest.setHeaders(details.headers),
      ),
    )
    .pipe(Effect.mapError(() => new PushUncertain({})))
  yield* acceptedStatus(response.status)
  return PushAcceptance.cases.Browser.make({})
})

/**
 * The Expo message for one payload. A notice the Person can answer names its category, so the
 * phone draws that category's buttons (Allow and Decline, or Review and Decline for a draft).
 */
const messageOf = (
  destination: typeof PushDestination.cases.Phone.Type,
  payload: PushPayload,
): typeof ExpoMessage.Type => {
  const message = {
    to: destination.token,
    title: payload.title,
    body: payload.body,
    sound: payload.sound === 'Audible' ? ('default' as const) : null,
    channelId: payload.sound === 'Audible' ? ('default' as const) : ('quiet' as const),
    data: payload,
    mutableContent: true,
    threadId: NotificationOpens.guards.Thread(payload.opens)
      ? payload.opens.threadId
      : payload.notificationId,
  }
  return PushAsk.match(payload.asks, {
    Nothing: (): typeof ExpoMessage.Type => ({
      ...message,
      categoryId: NotificationOpens.guards.Thread(payload.opens)
        ? ('vivid.thread' as const)
        : ('vivid.notice' as const),
    }),
    Approval: (): typeof ExpoMessage.Type => ({ ...message, categoryId: PUSH_CATEGORY.Approval }),
    Draft: (): typeof ExpoMessage.Type => ({ ...message, categoryId: PUSH_CATEGORY.Draft }),
  })
}

/** Expo HTTP v2 accepts one message and returns one ticket; no server secret is needed by default. */
const sendPhone = Effect.fn('PushAdapter.phone')(function* (
  destination: typeof PushDestination.cases.Phone.Type,
  payload: PushPayload,
) {
  // The exchange Scope owns this response and aborts whatever the caller leaves unread.
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const request = yield* HttpClientRequest.schemaBodyJson(ExpoMessage)(
    HttpClientRequest.post('https://exp.host/--/api/v2/push/send'),
    messageOf(destination, payload),
  ).pipe(Effect.mapError(() => new PushRejected({})))
  const response = yield* client.execute(request).pipe(Effect.mapError(() => new PushUncertain({})))
  yield* acceptedStatus(response.status)
  const result = yield* HttpClientResponse.schemaBodyJson(ExpoResponse)(response).pipe(
    Effect.mapError(() => new PushUncertain({})),
  )
  return yield* ExpoResult.match(result.data, {
    ok: ({ id }) =>
      Effect.succeed(PushAcceptance.cases.Phone.make({ ticket: id, confirmed: false })),
    error: ({ details }) =>
      Effect.fail(
        details !== undefined && details.error === 'DeviceNotRegistered'
          ? new PushTargetGone({})
          : new PushRejected({}),
      ),
  })
})

/** Expo can accept a ticket before APNs/FCM says a token is gone; receipt inspection is read-only. */
const inspectReceipt = Effect.fn('PushAdapter.receipt')(function* (ticket: string) {
  // The exchange Scope owns this response and aborts whatever the caller leaves unread.
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const request = yield* HttpClientRequest.schemaBodyJson(ReceiptRequest)(
    HttpClientRequest.post('https://exp.host/--/api/v2/push/getReceipts'),
    { ids: [ticket] },
  ).pipe(Effect.mapError(() => new PushRejected({})))
  const response = yield* client.execute(request).pipe(Effect.mapError(() => new PushUncertain({})))
  if (response.status !== 200) return yield* new PushRejected({})
  const result = yield* HttpClientResponse.schemaBodyJson(ExpoReceipts)(response).pipe(
    Effect.mapError(() => new PushUncertain({})),
  )
  const receipt = result.data[ticket]
  if (receipt === undefined) return Option.none<'Confirmed' | 'Gone' | 'Rejected'>()
  return Option.some(
    ExpoReceipt.match(receipt, {
      ok: () => 'Confirmed' as const,
      error: ({ details }) =>
        details !== undefined && details.error === 'DeviceNotRegistered'
          ? ('Gone' as const)
          : ('Rejected' as const),
    }),
  )
})

/** Each exchange Scope owns the scoped client response; the ten-second deadline includes decoding. */
const makePushAdapter = Effect.fn('PushAdapter.make')(function* () {
  // Keep stable authorities without shadowing the caller's Scope, Clock or request span.
  const services = Context.pick(
    HttpClient.HttpClient,
    PushConfig,
  )(yield* Effect.context<HttpClient.HttpClient | PushConfig>())
  return PushAdapter.of({
    send: Effect.fn('PushAdapter.send')(
      function* (destination, payload) {
        if (PushDestination.guards.Browser(destination))
          return yield* sendBrowser(destination, payload)
        return yield* sendPhone(destination, payload)
      },
      Effect.scoped,
      Effect.provideContext(services),
      Effect.timeoutOrElse({
        duration: PUSH_EXCHANGE_LIMIT,
        orElse: () => Effect.fail(new PushUncertain({})),
      }),
    ),
    receipt: Effect.fn('PushAdapter.inspect')((ticket) =>
      inspectReceipt(ticket).pipe(
        Effect.scoped,
        Effect.provideContext(services),
        Effect.timeoutOrElse({
          duration: PUSH_EXCHANGE_LIMIT,
          orElse: () => Effect.fail(new PushUncertain({})),
        }),
      ),
    ),
  })
})

/** The delivery Layer captures the same HTTP client and signing configuration as direct acquisition. */
export const pushAdapterLayer = Layer.effect(PushAdapter, makePushAdapter())
