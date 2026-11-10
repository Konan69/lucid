import * as NodeCrypto from 'node:crypto'
import * as Redacted from 'effect/Redacted'
import type { WatchId } from '@vivid/contracts'

/**
 * Standard Webhooks signing for Watch deliveries, the receiving half of what Executor sends.
 *
 * Executor signs every verification and delivery request with the secret the subscriber chose:
 * `webhook-signature: v1,<base64 HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<body>")>`,
 * keyed with the bytes after `whsec_`, and during a five-minute secret rotation it sends both
 * signatures space-separated (executor@2.0.0-beta.23 `packages/sdk/src/implementation/events.ts`
 * `sign` and `headers`; `secretKey` requires 24 to 64 bytes).
 */

/** How far a delivery's timestamp may be from now, either way, before it is refused as a replay. */
const TOLERANCE_SECONDS = 5 * 60

/**
 * The secret a Watch subscribes with. It is never stored: it is derived from the server's own
 * `AUTH_SECRET` and the Watch id, so the receiver can recompute it for any delivery and nothing in
 * the database can sign one. 32 bytes of HMAC output sit inside Executor's 24 to 64 byte bounds.
 */
export const secretFor = (authSecret: Redacted.Redacted, watch: WatchId) =>
  Redacted.make(
    `whsec_${NodeCrypto.createHmac('sha256', Redacted.value(authSecret))
      .update(`vivid/watch/${watch}`)
      .digest('base64')}`,
  )

/** The HMAC one signature must equal, as raw bytes. */
const expected = (secret: Redacted.Redacted, signed: Signed) =>
  NodeCrypto.createHmac(
    'sha256',
    Buffer.from(Redacted.value(secret).slice('whsec_'.length), 'base64'),
  )
    .update(`${signed.id}.${signed.timestamp}.${signed.body}`)
    .digest()

/** What a request carries to be checked: its three Standard Webhooks headers and the raw body. */
export interface Signed {
  readonly id: string
  readonly timestamp: string
  readonly signatures: string
  readonly body: string
}

/**
 * Whether a request was signed with this secret, recently. The timestamp must be whole Unix
 * seconds within `TOLERANCE_SECONDS` of `nowMillis`; one `v1,` entry among the space-separated
 * signatures must match, compared in constant time so a near miss teaches an attacker nothing.
 * Entries of another version are skipped, as Standard Webhooks asks.
 */
export const verify = (secret: Redacted.Redacted, signed: Signed, nowMillis: number) => {
  if (!/^\d{1,12}$/u.test(signed.timestamp)) return false
  const skew = Math.abs(nowMillis / 1000 - Number(signed.timestamp))
  if (skew > TOLERANCE_SECONDS) return false
  const wanted = expected(secret, signed)
  return signed.signatures
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => {
      const given = Buffer.from(entry.slice('v1,'.length), 'base64')
      return given.length === wanted.length && NodeCrypto.timingSafeEqual(given, wanted)
    })
}

/** Sign as Executor does, for the receiver's tests and the proof page's fixtures. */
export const sign = (secret: Redacted.Redacted, signed: Omit<Signed, 'signatures'>) =>
  `v1,${expected(secret, { ...signed, signatures: '' }).toString('base64')}`
