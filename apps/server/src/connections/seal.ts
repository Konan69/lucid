import * as NodeCrypto from 'node:crypto'
import { DatabaseFailure, type PersonId } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { requiredSetting, settingSecret } from '../config.ts'

/**
 * The secret behind each Person's Executor member: it seals the member's API key where it is
 * stored (`executorMembers` in `tables.ts`) and derives the member's password, which is never
 * stored. Losing it loses every member's sign-in, so it is set once per installation and never
 * rotated without moving the members too.
 *
 * The setting is 32 random bytes in base64 (`openssl rand -base64 32`). Two keys are derived from
 * it with HKDF-SHA256, one for sealing and one for passwords, so neither use can be turned against
 * the other.
 */
export const sealSecret = Effect.gen(function* () {
  const encoded = yield* requiredSetting(
    'VIVID_EXECUTOR_SEAL_KEY',
    settingSecret.check(
      Schema.makeFilter(
        (value) =>
          Buffer.from(Redacted.value(value), 'base64').length === 32 || '32 bytes in base64',
      ),
    ),
    '32 random bytes in base64',
  )
  const material = Buffer.from(Redacted.value(encoded), 'base64')
  /** HKDF with a label per use; the salt is empty because the input is already uniform. */
  const derive = (label: string) =>
    Buffer.from(NodeCrypto.hkdfSync('sha256', material, Buffer.alloc(0), label, 32))
  return {
    sealing: Redacted.make(derive('vivid executor member key seal')),
    passwords: Redacted.make(derive('vivid executor member password')),
  }
})
export type SealSecret = Effect.Success<typeof sealSecret>

const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * Seal one member's key. The Person id is the additional data, so a sealed key copied onto another
 * Person's row does not open there. The text is base64 of nonce, tag and ciphertext.
 */
export function seal(
  secret: SealSecret,
  person: PersonId,
  plaintext: Redacted.Redacted<string>,
): string {
  const nonce = NodeCrypto.randomBytes(NONCE_BYTES)
  const cipher = NodeCrypto.createCipheriv('aes-256-gcm', Redacted.value(secret.sealing), nonce)
  cipher.setAAD(Buffer.from(person, 'utf8'))
  const body = Buffer.concat([cipher.update(Redacted.value(plaintext), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * Open a sealed key. A value that does not open (another setting, another Person's row, or a
 * changed byte) is stored data that cannot be read, the same fault as a row that does not decode.
 */
export const unseal = Effect.fn('ExecutorMembers.unseal')(function* (
  secret: SealSecret,
  person: PersonId,
  sealed: string,
) {
  const raw = Buffer.from(sealed, 'base64')
  return yield* Effect.try({
    try: () => {
      const decipher = NodeCrypto.createDecipheriv(
        'aes-256-gcm',
        Redacted.value(secret.sealing),
        raw.subarray(0, NONCE_BYTES),
      )
      decipher.setAAD(Buffer.from(person, 'utf8'))
      decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES))
      const opened = Buffer.concat([
        decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
        decipher.final(),
      ])
      return Redacted.make(opened.toString('utf8'))
    },
    catch: () => new DatabaseFailure({ message: 'Executor member key could not be opened' }),
  })
})

/**
 * The member's Executor password: HMAC-SHA256 of its email under the password key, in base64url
 * (43 characters, inside Executor's 8 to 128). Derived on each use and never stored, so a lost
 * key is minted again by signing in with it.
 */
export function memberPassword(secret: SealSecret, email: string): Redacted.Redacted<string> {
  return Redacted.make(
    NodeCrypto.createHmac('sha256', Redacted.value(secret.passwords))
      .update(email, 'utf8')
      .digest('base64url'),
  )
}
