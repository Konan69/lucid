import * as NodeCrypto from 'node:crypto'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import { ConfigurationError, requiredSetting } from '../config.ts'

/**
 * The server's own identity towards browser push services (VAPID, RFC 8292): the public key a
 * browser subscribes against, the private key that signs every send, and the contact address a
 * push service may use. Away notifications are part of every running Vivid, so this always exists.
 */
export interface PushConfiguration {
  readonly publicKey: string
  readonly privateKey: Redacted.Redacted
  readonly subject: string
}
export class PushConfig extends Context.Service<PushConfig, PushConfiguration>()(
  'vivid/PushConfig',
) {}

/** An uncompressed P-256 point in unpadded base64url: 65 bytes, so always 87 characters. */
const publicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/u))

/** RFC 8292 allows only these two schemes; a push service refuses a send signed with another. */
const subject = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (URL.canParse(value) && /^(?:https:|mailto:)$/u.test(new URL(value).protocol)) ||
      'an https: or mailto: address',
  ),
)

const mismatched = () =>
  new ConfigurationError({
    variable: 'VIVID_PUSH_VAPID_PRIVATE',
    expected: 'the private key of VIVID_PUSH_VAPID_PUBLIC',
    message:
      'VIVID_PUSH_VAPID_PRIVATE is missing or invalid: expected the private key of VIVID_PUSH_VAPID_PUBLIC',
  })

/**
 * All three settings are required and checked while the server is composed; a missing one, a
 * subject a push service would refuse, or a private key that does not belong to the public key
 * stops launch naming the variable. Otherwise the server would hand browsers a public key it can
 * never sign for, and every away notification would be refused by the push service later.
 *
 * A push service or Expo being down is a different fact: it is a typed failure of the one send
 * that met it (`PushSendError`), recorded on that delivery, and the next send tries again.
 */
export const loadPushConfiguration = Effect.fn('PushConfig.load')(function* () {
  const configuration = {
    publicKey: yield* requiredSetting(
      'VIVID_PUSH_VAPID_PUBLIC',
      publicKey,
      'a base64url VAPID public key',
    ),
    privateKey: yield* requiredSetting(
      'VIVID_PUSH_VAPID_PRIVATE',
      Schema.RedactedFromValue(Schema.NonEmptyString),
      'a base64url VAPID private key',
    ),
    subject: yield* requiredSetting('VIVID_PUSH_SUBJECT', subject, 'an https: or mailto: address'),
  }
  // Node refuses a private key that is not on the curve by throwing; both that and a key from
  // another pair are the same operator mistake, reported without carrying either value.
  const derived = yield* Effect.try({
    try: () => {
      const curve = NodeCrypto.createECDH('prime256v1')
      curve.setPrivateKey(Buffer.from(Redacted.value(configuration.privateKey), 'base64url'))
      return curve.getPublicKey().toString('base64url')
    },
    catch: mismatched,
  })
  if (derived !== configuration.publicKey) return yield* mismatched()
  return configuration
})

export const pushConfigLayer = Layer.effect(PushConfig, loadPushConfiguration())
