import * as NodeCrypto from 'node:crypto'
import * as NodeHttp2 from 'node:http2'
import { Clock, Context, Effect, Layer, Redacted } from 'effect'
import type { ActivitySnapshot } from '@vivid/contracts'
import { PushRejected, PushTargetGone, PushUncertain } from '../push/receipts.ts'

export interface Credentials {
  readonly team: string
  readonly keyId: string
  readonly key: Redacted.Redacted
  readonly bundle: string
  readonly environment: 'production' | 'sandbox'
}

/** APNs requires ES256 with the raw IEEE-P1363 signature, rather than Node's DER default. */
const authorization = (credentials: Credentials, seconds: number) =>
  Effect.try({
    try: () => {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: credentials.keyId })).toString(
        'base64url',
      )
      const claims = Buffer.from(JSON.stringify({ iss: credentials.team, iat: seconds })).toString(
        'base64url',
      )
      const unsigned = `${header}.${claims}`
      const signature = NodeCrypto.sign('sha256', Buffer.from(unsigned), {
        key: Redacted.value(credentials.key),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
      return `${unsigned}.${signature}`
    },
    catch: () => new PushRejected({}),
  })

/**
 * How long a card's content counts as current to the system. Vivid pushes when work changes,
 * plus a heartbeat while a Run lasts (`threads/delivery.ts`), so ten minutes passes only when the
 * server has lost touch. The card shows no staleness line (Konan asked for it gone); the date
 * still tells iOS the content is old. T3 Code's relay uses the same ten minutes
 * (`infra/relay/src/agentActivity/ApnsClient.ts` `STALE_AFTER_SECONDS`).
 */
const STALE_AFTER_SECONDS = 10 * 60
/** An ended card with an outcome stays long enough to be read on the next glance (T3: five minutes). */
const DISMISS_AFTER_SECONDS = 5 * 60
/** An ended card with nothing to show leaves almost at once rather than freezing (T3: fifteen seconds). */
const EMPTY_DISMISS_AFTER_SECONDS = 15

/**
 * Each HTTP/2 exchange owns its socket. Cancellation and every response close both resources.
 * Only `update` and `end` exist: the app starts the card itself (`@vivid/contracts`
 * `ActivityRegistration`), so the server never sends `start`.
 */
const sendActivity = Effect.fn('Activity.send')(function* (
  credentials: Credentials,
  token: string,
  event: 'update' | 'end',
  snapshot: ActivitySnapshot,
) {
  const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const jwt = yield* authorization(credentials, seconds)
  const aps = {
    update: {
      timestamp: seconds,
      event: 'update',
      'content-state': snapshot,
      'stale-date': seconds + STALE_AFTER_SECONDS,
    },
    end: {
      timestamp: seconds,
      event: 'end',
      'content-state': snapshot,
      'dismissal-date':
        seconds + (snapshot.rows.length > 0 ? DISMISS_AFTER_SECONDS : EMPTY_DISMISS_AFTER_SECONDS),
    },
  }[event]
  const status = yield* Effect.callback<number, PushUncertain>((resume) => {
    const host =
      credentials.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
    const client = NodeHttp2.connect(`https://${host}`)
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': `${credentials.bundle}.push-type.liveactivity`,
      // An end is the last word on the card, so it goes at once; updates take the cheap lane.
      'apns-priority': event === 'end' ? '10' : '5',
    })
    client.once('error', () => resume(Effect.fail(new PushUncertain({}))))
    request.once('error', () => resume(Effect.fail(new PushUncertain({}))))
    request.once('response', (headers) => resume(Effect.succeed(Number(headers[':status']))))
    request.end(JSON.stringify({ aps }))
    return Effect.sync(() => {
      request.close()
      client.destroy()
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 seconds',
      orElse: () => Effect.fail(new PushUncertain({})),
    }),
  )
  if (status === 410) return yield* new PushTargetGone({})
  if (status !== 200) return yield* new PushRejected({})
}, Effect.asVoid)

/** APNs owns external delivery authority; tests replace only this network boundary. */
export interface ActivityPushService {
  readonly send: typeof sendActivity
}
export class ActivityPush extends Context.Service<ActivityPush, ActivityPushService>()(
  'vivid/ActivityPush',
) {}
export const activityPushLayer = Layer.succeed(ActivityPush, { send: sendActivity })
