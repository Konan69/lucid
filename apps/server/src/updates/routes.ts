import * as NodeCrypto from 'node:crypto'
import { Effect, Layer, Option, Schema } from 'effect'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { answerUpdate, findAsset, type UpdatePart } from './manifest.ts'
import { loadCatalog, Platform, type Catalog } from './release.ts'

/**
 * The two addresses the mobile app's expo-updates client calls: one to ask whether there is newer
 * JavaScript for its binary, one to download each file of it. They are plain HTTP because the
 * caller is the native update client, not our RPC client, and they take no session: an update is
 * the same app anyone holding the binary already has, and it must load before anyone signs in.
 *
 * Ported from `expo-updates-server/pages/api/manifest.ts` and `assets.ts` in
 * expo/custom-expo-updates-server; statuses and error sentences are the reference's. Code signing
 * is not: the reference signs a manifest with a key file when the client asks, this server holds
 * no such key and says so to a client that expects a signature.
 */

class ProtocolVersionUnsupported extends Schema.TaggedError<ProtocolVersionUnsupported>()(
  'ProtocolVersionUnsupported',
  {},
  { title: 'Update protocol version unsupported' },
) {}
class PlatformUnsupported extends Schema.TaggedError<PlatformUnsupported>()(
  'PlatformUnsupported',
  {},
  { title: 'Update platform unsupported' },
) {}
class RuntimeVersionRequired extends Schema.TaggedError<RuntimeVersionRequired>()(
  'RuntimeVersionRequired',
  {},
  { title: 'Update runtime version required' },
) {}
class SignatureUnavailable extends Schema.TaggedError<SignatureUnavailable>()(
  'SignatureUnavailable',
  {},
  { title: 'Update signature unavailable' },
) {}
/** Nothing is published for the binary asking: its runtime version or its platform is unknown. */
class UpdateNotPublished extends Schema.TaggedError<UpdateNotPublished>()(
  'UpdateNotPublished',
  { runtimeVersion: Schema.String, platform: Platform },
  { title: 'Update not published' },
) {}
class AssetNotFound extends Schema.TaggedError<AssetNotFound>()(
  'AssetNotFound',
  {},
  { title: 'Update asset not found' },
) {}

/** A request with no `expo-protocol-version` speaks version 0, as the reference reads it. */
const decodeProtocolVersion = Schema.decodeUnknownOption(Schema.Literals(['0', '1']))
const decodePlatform = Schema.decodeUnknownOption(Platform)
const decodeRuntimeVersion = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isNonEmpty({ message: 'a runtime version' })),
)

/**
 * The binary's platform and runtime version, which both routes need. The client sends them as
 * headers on a manifest request and the manifest's asset URLs carry them as a query; the reference
 * accepts either on the manifest route, header first, and so does this.
 */
const readBinary = Effect.fn('Updates.readBinary')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const query = new URL(request.url, 'http://vivid.local').searchParams
  const platform = decodePlatform(request.headers['expo-platform'] ?? query.get('platform'))
  if (Option.isNone(platform)) return yield* Effect.fail(new PlatformUnsupported({}))
  const runtimeVersion = decodeRuntimeVersion(
    request.headers['expo-runtime-version'] ??
      query.get('runtime-version') ??
      query.get('runtimeVersion'),
  )
  if (Option.isNone(runtimeVersion)) return yield* Effect.fail(new RuntimeVersionRequired({}))
  return { platform: platform.value, runtimeVersion: runtimeVersion.value, query }
})

/**
 * `multipart/mixed` as the reference's `form-data` writes it and expo-updates reads it: each part
 * is found by the `name` in its `Content-Disposition`. The boundary is random so that no JSON body
 * can contain it.
 */
const multipart = (parts: ReadonlyArray<UpdatePart>, protocolVersion: number) => {
  const boundary = `vivid-${NodeCrypto.randomUUID()}`
  const body = parts
    .map(
      (part) =>
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${part.name}"\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n\r\n' +
        `${JSON.stringify(part.body)}\r\n`,
    )
    .join('')
  return HttpServerResponse.text(`${body}--${boundary}--\r\n`, {
    contentType: `multipart/mixed; boundary=${boundary}`,
    headers: {
      'expo-protocol-version': String(protocolVersion),
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
    },
  })
}

/** The check itself: read what the binary says about itself and answer with the parts for it. */
const manifest = Effect.fn('Updates.manifest')(function* (catalog: Catalog, publicUrl: URL) {
  const request = yield* HttpServerRequest.HttpServerRequest
  const version = decodeProtocolVersion(request.headers['expo-protocol-version'] ?? '0')
  if (Option.isNone(version)) return yield* Effect.fail(new ProtocolVersionUnsupported({}))
  const protocolVersion = Number(version.value)
  const binary = yield* readBinary()
  if (request.headers['expo-expect-signature'] !== undefined)
    return yield* Effect.fail(new SignatureUnavailable({}))
  const parts = answerUpdate(catalog, publicUrl, {
    protocolVersion,
    platform: binary.platform,
    runtimeVersion: binary.runtimeVersion,
    currentUpdateId: Option.fromUndefinedOr(request.headers['expo-current-update-id']),
  })
  if (Option.isNone(parts)) return yield* Effect.fail(new UpdateNotPublished(binary))
  return multipart(parts.value, protocolVersion)
})

/**
 * An asset URL names its file by content (`key` is the MD5 of the bytes), so the same URL can
 * never mean different bytes and the answer may be cached for good.
 */
const asset = Effect.fn('Updates.asset')(function* (catalog: Catalog) {
  const binary = yield* readBinary()
  const key = binary.query.get('asset')
  if (key === null) return yield* Effect.fail(new AssetNotFound({}))
  const file = findAsset(catalog, { ...binary, key })
  if (Option.isNone(file)) return yield* Effect.fail(new AssetNotFound({}))
  return yield* HttpServerResponse.file(file.value.path, {
    contentType: file.value.contentType,
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  })
})

const refuse = (status: number, error: string) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status }))

/** The reference's statuses and sentences: a request that cannot be read is 400. */
const unreadable = {
  PlatformUnsupported: () => refuse(400, 'Unsupported platform. Expected either ios or android.'),
  RuntimeVersionRequired: () => refuse(400, 'No runtimeVersion provided.'),
}

/**
 * Registers the update routes when this server was given updates to serve. The directory is read
 * once here, so a directory that cannot be read stops the launch instead of failing each phone.
 * Without one (local development with no published update) the routes do not exist and a phone's
 * check is answered 404, which expo-updates treats as "keep running what you have".
 */
export function updateRoutes(directory: Option.Option<string>, publicUrl: URL) {
  if (Option.isNone(directory)) return Layer.empty
  return HttpRouter.use(
    Effect.fn('Updates.register')(function* (router) {
      const catalog = yield* loadCatalog(directory.value)
      yield* router.add(
        'GET',
        '/api/updates/manifest',
        manifest(catalog, publicUrl).pipe(
          Effect.catchTags({
            ...unreadable,
            ProtocolVersionUnsupported: () =>
              refuse(400, 'Unsupported protocol version. Expected either 0 or 1.'),
            SignatureUnavailable: () =>
              refuse(400, 'Code signing requested but this server has no signing key.'),
            // Nothing to give is 404; the sentence names the binary so one request shows a mismatch.
            UpdateNotPublished: (failure) =>
              refuse(
                404,
                `No update is published for ${failure.platform} runtime version ${failure.runtimeVersion}.`,
              ),
          }),
        ),
      )
      yield* router.add(
        'GET',
        '/api/updates/assets',
        asset(catalog).pipe(
          Effect.catchTags({ ...unreadable, AssetNotFound: () => refuse(404, 'Asset not found.') }),
        ),
      )
    }),
  )
}
