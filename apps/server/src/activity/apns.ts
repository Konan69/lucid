import * as NodeCrypto from 'node:crypto'
import * as NodeHttp2 from 'node:http2'
import { Clock, Effect, Redacted } from 'effect'
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

/** Each HTTP/2 exchange owns its socket. Cancellation and every response close both resources. */
export const sendActivity = Effect.fn('Activity.send')(function* (
  credentials: Credentials,
  token: string,
  event: 'start' | 'update' | 'end',
  snapshot: ActivitySnapshot,
) {
  const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const jwt = yield* authorization(credentials, seconds)
  const content = { snapshot }
  const aps = {
    start: {
      timestamp: seconds,
      event: 'start',
      'content-state': content,
      'stale-date': seconds + 300,
      'attributes-type': 'VividActivityAttributes',
      attributes: {},
      'input-push-token': 1,
      alert: { title: 'Vivid', body: snapshot.title },
    },
    update: {
      timestamp: seconds,
      event: 'update',
      'content-state': content,
      'stale-date': seconds + 300,
    },
    end: {
      timestamp: seconds,
      event: 'end',
      'content-state': content,
      'dismissal-date': seconds + 60,
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
      'apns-priority': event === 'start' ? '10' : '5',
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
})
