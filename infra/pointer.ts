import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

/**
 * Where celld keeps a fleet: the five settings celld itself reads (`CELLD_BUCKET`, `S3_ENDPOINT`,
 * `AWS_REGION` and the key pair; `celld deploy --help`).
 */
export interface FleetStorage {
  /** `s3://NAME` or `s3://NAME/PREFIX`, as `CELLD_BUCKET`. */
  readonly bucket: string
  readonly endpoint: string
  readonly region: string
  readonly accessKeyId: Redacted.Redacted
  readonly secretAccessKey: Redacted.Redacted
}

/**
 * The fleet storage as `Railway.Bucket` outputs it (`alchemy/src/Railway/Bucket.ts`): every
 * attribute but the bucket name is absent until Railway has made the bucket and its keys.
 */
export interface BucketStorage {
  readonly bucket: string
  readonly endpoint?: string
  readonly region?: string
  readonly accessKeyId?: Redacted.Redacted
  readonly secretAccessKey?: Redacted.Redacted
}

/** The bucket has no endpoint, region or key yet, so nothing in it can be read. */
class FleetStorageMissing extends Schema.TaggedError<FleetStorageMissing>()(
  'FleetStorageMissing',
  { message: Schema.String },
  { title: 'Fleet storage missing' },
) {}

/** The bucket's outputs as the storage celld and the pointer read need, or a typed failure. */
export const fleetStorage = Effect.fn('Infra.fleetStorage')(function* (outputs: BucketStorage) {
  const { bucket, endpoint, region, accessKeyId, secretAccessKey } = outputs
  if (
    endpoint === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  )
    return yield* new FleetStorageMissing({
      message: 'the cells bucket has no endpoint, region or keys yet',
    })
  return { bucket, endpoint, region, accessKeyId, secretAccessKey } satisfies FleetStorage
})

/**
 * The fleet pointer could not be read. `reason` names which part failed (the request, a refusal by
 * status, or a body that is not a celld pointer) and never carries the URL, a key or the body.
 */
class FleetPointerUnreadable extends Schema.TaggedError<FleetPointerUnreadable>()(
  'FleetPointerUnreadable',
  { reason: Schema.String },
  { title: 'Fleet pointer unreadable' },
) {}

/**
 * celld's fleet-wide deployment pointer, `deploy/current.json`: the object every node polls and
 * adopts in place. celld writes the named pointer first and this one last, so this is what the
 * fleet runs. Only `version` is read; celld's other fields stay its own.
 */
const decodePointer = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })),
)

const sha256 = (value: string) => NodeCrypto.createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string) =>
  NodeCrypto.createHmac('sha256', key).update(value).digest()

/**
 * One path-style S3 GET, signed with AWS Signature Version 4 for an empty body (AWS, "Create a
 * signed AWS API request"). By hand because neither the server image nor the deploying machine has
 * an S3 client the root can import, and this is the only object either one reads.
 */
const signedGet = (storage: FleetStorage, key: string) => {
  const [name = '', ...prefix] = storage.bucket.replace(/^s3:\/\//, '').split('/')
  const path = [name, ...prefix.filter((part) => part.length > 0), ...key.split('/')]
  const url = new URL(`/${path.map(encodeURIComponent).join('/')}`, storage.endpoint)
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
  const scope = `${day}/${storage.region}/s3/aws4_request`
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${Redacted.value(storage.secretAccessKey)}`, day), storage.region), 's3'),
    'aws4_request',
  )
  const signature = NodeCrypto.createHmac('sha256', signingKey)
    .update(['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n'))
    .digest('hex')
  return HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({
      'x-amz-content-sha256': empty,
      'x-amz-date': stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${Redacted.value(storage.accessKeyId)}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    }),
  )
}

/**
 * Which Worker version the fleet selects, read straight from the bucket, so a publish is judged by
 * what the nodes load and not by what the publisher printed. This is the read-back the
 * 30 October to 10 November 2026 outage lacked: 59 deploys never published and nothing looked.
 * `None` when the bucket holds no pointer yet.
 */
export const readPointer = Effect.fn('Infra.readPointer')(function* (storage: FleetStorage) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(signedGet(storage, 'deploy/current.json'))
    .pipe(Effect.mapError(() => new FleetPointerUnreadable({ reason: 'the request failed' })))
  if (response.status === 404) return Option.none<string>()
  if (response.status !== 200)
    return yield* new FleetPointerUnreadable({ reason: `refused with HTTP ${response.status}` })
  const body = yield* response.text.pipe(
    Effect.mapError(() => new FleetPointerUnreadable({ reason: 'the body could not be read' })),
  )
  const pointer = yield* decodePointer(body).pipe(
    Effect.mapError(() => new FleetPointerUnreadable({ reason: 'not a celld pointer' })),
  )
  return Option.some(pointer.version)
})
