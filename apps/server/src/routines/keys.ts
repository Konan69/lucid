import * as NodeCrypto from 'node:crypto'
import * as Redacted from 'effect/Redacted'

/** The bearer credential is shown once; persistence and comparisons use only its SHA-256. */
export const hashKey = (key: Redacted.Redacted) =>
  NodeCrypto.createHash('sha256').update(Redacted.value(key)).digest('hex')

/** Fixed-size digests make comparison constant time, regardless of credential length. */
export const matchesKey = (key: Redacted.Redacted, hash: string) => {
  const supplied = Buffer.from(hashKey(key), 'hex')
  const stored = Buffer.from(hash, 'hex')
  return stored.length === supplied.length && NodeCrypto.timingSafeEqual(supplied, stored)
}

/** 256 bits of fresh randomness revoke any previously issued authority when the hash is replaced. */
export const issueKey = () => Redacted.make(NodeCrypto.randomBytes(32).toString('base64url'))
