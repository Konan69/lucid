import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Redacted } from 'effect'
import { WatchId } from '@vivid/contracts'
import { secretFor, sign, verify } from './signature.ts'

const authSecret = Redacted.make('test-Auth_secret-0123456789-ABCDEFG')
const watch = WatchId.make('watch-one')
const secret = secretFor(authSecret, watch)
const now = 1_800_000_000_000
const timestamp = String(now / 1000)
const body =
  '{"eventId":"e1","name":"mail.message.received","timestamp":"t","data":{},"cursor":null}'

/**
 * Executor's own signing, re-derived from the Standard Webhooks rule rather than this module's
 * `sign`: HMAC-SHA256 keyed with the base64 bytes after `whsec_`, over `id.timestamp.body`.
 */
const executorSigns = (key: Redacted.Redacted, text: string) =>
  `v1,${NodeCrypto.createHmac('sha256', Buffer.from(Redacted.value(key).slice(6), 'base64'))
    .update(`msg_1.${timestamp}.${text}`)
    .digest('base64')}`

describe('Watch delivery signatures', () => {
  it('derives a whsec secret Executor accepts, stable per Watch and distinct between Watches', () => {
    const value = Redacted.value(secret)
    expect(value).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/u)
    const bytes = Buffer.from(value.slice(6), 'base64').byteLength
    expect(bytes).toBeGreaterThanOrEqual(24)
    expect(bytes).toBeLessThanOrEqual(64)
    expect(Redacted.value(secretFor(authSecret, watch))).toBe(value)
    expect(Redacted.value(secretFor(authSecret, WatchId.make('watch-two')))).not.toBe(value)
  })

  it('accepts a request Executor signed with this Watch’s secret', () => {
    const signatures = executorSigns(secret, body)
    expect(verify(secret, { id: 'msg_1', timestamp, signatures, body }, now)).toBe(true)
    expect(sign(secret, { id: 'msg_1', timestamp, body })).toBe(signatures)
  })

  it('refuses another Watch’s secret', () => {
    const other = secretFor(authSecret, WatchId.make('watch-two'))
    const signatures = executorSigns(other, body)
    expect(verify(secret, { id: 'msg_1', timestamp, signatures, body }, now)).toBe(false)
  })

  it('refuses a tampered body', () => {
    const signatures = executorSigns(secret, body)
    const tampered = body.replace('e1', 'e2')
    expect(verify(secret, { id: 'msg_1', timestamp, signatures, body: tampered }, now)).toBe(false)
  })

  it('refuses a timestamp more than five minutes from now, either way', () => {
    const signatures = executorSigns(secret, body)
    const signed = { id: 'msg_1', timestamp, signatures, body }
    expect(verify(secret, signed, now + 5 * 60_000)).toBe(true)
    expect(verify(secret, signed, now + 5 * 60_000 + 1000)).toBe(false)
    expect(verify(secret, signed, now - 5 * 60_000 - 1000)).toBe(false)
    expect(verify(secret, { ...signed, timestamp: 'soon' }, now)).toBe(false)
  })

  it('accepts any one of several signatures, as during Executor’s secret rotation', () => {
    const old = executorSigns(secretFor(authSecret, WatchId.make('rotated')), body)
    const current = executorSigns(secret, body)
    for (const signatures of [`${old} ${current}`, `${current} ${old}`, `v2,abc ${current}`])
      expect(verify(secret, { id: 'msg_1', timestamp, signatures, body }, now)).toBe(true)
    expect(verify(secret, { id: 'msg_1', timestamp, signatures: `${old} v1,`, body }, now)).toBe(
      false,
    )
  })
})
