import * as NodeCrypto from 'node:crypto'
import { Result, Schema } from 'effect'

/**
 * celld's fleet-wide deployment pointer, `deploy/current.json`: the one object every node polls
 * and adopts in place (`celld deploy --help`). celld writes the named pointer first and this one
 * last, so this is what the fleet runs. Only `version` is read; celld's other fields stay its own.
 */
const Pointer = Schema.Struct({ version: Schema.NonEmptyString })
const decodePointer = Schema.decodeUnknownResult(Schema.fromJsonString(Pointer))

const sha256 = (value) => NodeCrypto.createHash('sha256').update(value).digest('hex')
const hmac = (key, value) => NodeCrypto.createHmac('sha256', key).update(value).digest()

/**
 * Reads which Worker version the fleet selects, straight from the bucket, so a publish is judged by
 * what the nodes will load and not by what the publisher printed. This is the read-back the
 * 30 October to 10 November outage lacked: 59 deploys never published and nothing looked.
 *
 * The storage is the same five settings celld itself reads (`CELLD_BUCKET`, `S3_ENDPOINT`,
 * `AWS_REGION` and the key pair). The request is one path-style S3 GET signed with AWS Signature
 * Version 4 by hand, because neither the image nor the deploying machine has an S3 client this
 * module could import; the signing follows AWS's "Signature Version 4 signing process" for a
 * request with an empty body. Answers the version, or `null` when the bucket has no pointer yet.
 */
export async function readPointer({ bucket, endpoint, region, accessKeyId, secretAccessKey }) {
  const [name, ...prefix] = bucket.replace(/^s3:\/\//, '').split('/')
  const key = [...prefix.filter((part) => part.length > 0), 'deploy', 'current.json'].join('/')
  const url = new URL(
    `/${[name, ...key.split('/')].map(encodeURIComponent).join('/')}`,
    endpoint,
  )
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = stamp.slice(0, 8)
  const empty = sha256('')
  const signed = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [
    'GET',
    url.pathname,
    '',
    `host:${url.host}\nx-amz-content-sha256:${empty}\nx-amz-date:${stamp}\n`,
    signed,
    empty,
  ].join('\n')
  const scope = `${day}/${region}/s3/aws4_request`
  const key4 = ['s3', 'aws4_request'].reduce(
    hmac,
    hmac(hmac(`AWS4${secretAccessKey}`, day), region),
  )
  const signature = NodeCrypto.createHmac('sha256', key4)
    .update(['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n'))
    .digest('hex')
  const response = await fetch(url, {
    headers: {
      'x-amz-content-sha256': empty,
      'x-amz-date': stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
  })
  if (response.status === 404) return null
  // The status names the refusal; the body and the URL stay out of the message.
  if (!response.ok) throw new Error(`the fleet pointer read was refused with HTTP ${response.status}`)
  const pointer = decodePointer(await response.text())
  if (Result.isFailure(pointer)) throw new Error('the fleet pointer is not a celld pointer')
  return pointer.success.version
}

/** The storage settings as celld reads them from its environment. */
export const storageFromEnvironment = (environment) => {
  const names = ['CELLD_BUCKET', 'S3_ENDPOINT', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
  const missing = names.filter((name) => !environment[name])
  if (missing.length > 0) throw new Error(`the fleet storage settings are missing: ${missing.join(', ')}`)
  return {
    bucket: environment.CELLD_BUCKET,
    endpoint: environment.S3_ENDPOINT,
    region: environment.AWS_REGION,
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
  }
}
