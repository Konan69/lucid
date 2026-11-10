import * as NodeCrypto from 'node:crypto'
import { Array, Effect, FileSystem, Option, Path, Schema } from 'effect'
import mime from 'mime'

/**
 * The over-the-air updates this server can hand to the mobile app, read from disk once at launch.
 *
 * Ported from `expo-updates-server/common/helpers.ts` in expo/custom-expo-updates-server, the
 * reference server for the Expo Updates protocol. The directory layout is the reference's:
 *
 *   <root>/<runtime version>/<publish time, epoch seconds>/
 *     metadata.json     written by `expo export`: the bundle and assets of each platform
 *     expoConfig.json   the public Expo config, served to the app as `extra.expoClient`
 *     _expo/, assets/   the files themselves
 *
 * `apps/mobile/scripts/publish.mjs` writes it. A runtime version names one native binary: an
 * update only ever goes to a binary whose runtime version is its directory name, and the newest
 * publish time under that name is the one served.
 *
 * Three changes from the reference, each because this directory is part of the server image:
 * - It is read once here and never again. The reference re-reads and re-hashes every file on every
 *   request; an image's files cannot change under a running server.
 * - `createdAt` is the publish-time directory name. The reference uses `metadata.json`'s birth
 *   time, which a container image layer does not keep.
 * - Rollback directories (`rollback` files) are not read. Nothing here publishes one; a bad update
 *   is replaced by deploying a newer one.
 */

/** The platforms an `expo export` can carry, and the only values `expo-platform` may name. */
export const Platform = Schema.Literals(['ios', 'android'])
export type Platform = typeof Platform.Type

/** One platform's entry in `metadata.json`: paths are relative to the release directory. */
const ExportedFiles = Schema.Struct({
  bundle: Schema.String,
  assets: Schema.Array(Schema.Struct({ path: Schema.String, ext: Schema.String })),
})

/** An export made for one platform has no entry for the other, so each key may be absent. */
const Metadata = Schema.Struct({
  fileMetadata: Schema.Struct({
    ios: Schema.optionalKey(ExportedFiles),
    android: Schema.optionalKey(ExportedFiles),
  }),
})

/**
 * The public Expo config. Only `extra` is read (the manifest lays this server's address over it,
 * see `manifest.ts`); every other key is relayed to the app as it was exported.
 */
const ExpoConfig = Schema.StructWithRest(
  Schema.Struct({ extra: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type ExpoConfig = typeof ExpoConfig.Type

const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata))
const decodeExpoConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoConfig))

/** A release directory whose `metadata.json` or `expoConfig.json` is not what `expo export` writes. */
class ReleaseUnreadable extends Schema.TaggedError<ReleaseUnreadable>()(
  'ReleaseUnreadable',
  { directory: Schema.String, file: Schema.String },
  { title: 'Mobile update release unreadable' },
) {}

/**
 * One file of a release as the protocol describes it (`hash`, `key`, `fileExtension`,
 * `contentType`), plus where it is on disk. `key` is also how the asset route finds the file, so
 * a request never names a path.
 */
export interface ReleaseFile {
  /** SHA-256 of the bytes, base64url without padding; the app refuses a download that differs. */
  readonly hash: string
  /** MD5 of the bytes in hex; the app's cache key for the file. */
  readonly key: string
  readonly fileExtension: string
  readonly contentType: string
  readonly path: string
}

interface PlatformFiles {
  readonly launchAsset: ReleaseFile
  readonly assets: ReadonlyArray<ReleaseFile>
}

export interface Release {
  /** SHA-256 of `metadata.json` shaped as a UUID, so the same export always has the same id. */
  readonly id: string
  readonly createdAt: string
  readonly runtimeVersion: string
  readonly expoConfig: ExpoConfig
  readonly platforms: ReadonlyMap<Platform, PlatformFiles>
}

/** The newest release of each runtime version. */
export type Catalog = ReadonlyMap<string, Release>

/** `helpers.ts:convertSHA256HashToUUID`: the first 32 hex digits in the 8-4-4-4-12 grouping. */
const uuidFromHash = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`

/**
 * `helpers.ts:getAssetMetadataAsync`. The launch asset has no extension in `metadata.json`; the
 * protocol names it `.bundle` and JavaScript whatever the file is called (Hermes bytecode here).
 */
const describeFile = Effect.fn('Updates.describeFile')(function* (
  directory: string,
  relative: string,
  kind: { readonly fileExtension: string; readonly contentType: string },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(directory, relative)
  const bytes = yield* fs.readFile(file)
  return {
    hash: NodeCrypto.createHash('sha256').update(bytes).digest('base64url'),
    key: NodeCrypto.createHash('md5').update(bytes).digest('hex'),
    fileExtension: kind.fileExtension,
    contentType: kind.contentType,
    path: file,
  } satisfies ReleaseFile
})

/**
 * An extension the MIME table does not know is sent as plain bytes, HTTP's own name for "type
 * unknown". The app stores an asset by its `fileExtension`, so the type only labels the download.
 */
const assetKind = (ext: string) => {
  const known = mime.getType(ext)
  return {
    fileExtension: `.${ext}`,
    contentType: known === null ? 'application/octet-stream' : known,
  }
}

const describePlatform = Effect.fn('Updates.describePlatform')(function* (
  directory: string,
  files: typeof ExportedFiles.Type,
) {
  return {
    launchAsset: yield* describeFile(directory, files.bundle, {
      fileExtension: '.bundle',
      contentType: 'application/javascript',
    }),
    assets: yield* Effect.forEach(files.assets, (asset) =>
      describeFile(directory, asset.path, assetKind(asset.ext)),
    ),
  } satisfies PlatformFiles
})

/** `helpers.ts:getMetadataAsync` and `getExpoConfigAsync`, for one release directory. */
const loadRelease = Effect.fn('Updates.loadRelease')(function* (
  directory: string,
  runtimeVersion: string,
  publishedAt: number,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unreadable = (file: string) => () => new ReleaseUnreadable({ directory, file })
  const metadataBytes = yield* fs.readFile(path.join(directory, 'metadata.json'))
  const metadata = yield* decodeMetadata(new TextDecoder().decode(metadataBytes)).pipe(
    Effect.mapError(unreadable('metadata.json')),
  )
  const expoConfig = yield* decodeExpoConfig(
    yield* fs.readFileString(path.join(directory, 'expoConfig.json')),
  ).pipe(Effect.mapError(unreadable('expoConfig.json')))
  const platforms = new Map<Platform, PlatformFiles>()
  for (const platform of Platform.literals) {
    const files = metadata.fileMetadata[platform]
    if (files !== undefined) platforms.set(platform, yield* describePlatform(directory, files))
  }
  return {
    id: uuidFromHash(NodeCrypto.createHash('sha256').update(metadataBytes).digest('hex')),
    createdAt: new Date(publishedAt * 1000).toISOString(),
    runtimeVersion,
    expoConfig,
    platforms,
  } satisfies Release
})

/** The names of the directories directly inside `directory`; files beside them are not releases. */
const directories = Effect.fn('Updates.directories')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* fs.readDirectory(directory)
  const kept = yield* Effect.forEach(names, (name) =>
    Effect.map(fs.stat(path.join(directory, name)), (info) =>
      info.type === 'Directory' ? Option.some(name) : Option.none<string>(),
    ),
  )
  return Array.getSomes(kept)
})

/**
 * `helpers.ts:getLatestUpdateBundlePathForRuntimeVersionAsync`, for every runtime version at
 * once. A runtime directory with no publish-time directory in it has nothing to serve and is left
 * out, so a request for it is answered like any runtime this server has never heard of.
 */
export const loadCatalog = Effect.fn('Updates.loadCatalog')(function* (root: string) {
  const path = yield* Path.Path
  const catalog = new Map<string, Release>()
  for (const runtimeVersion of yield* directories(root)) {
    const published = (yield* directories(path.join(root, runtimeVersion)))
      .filter((name) => /^\d+$/u.test(name))
      .map(Number)
    if (published.length === 0) continue
    const latest = Math.max(...published)
    catalog.set(
      runtimeVersion,
      yield* loadRelease(path.join(root, runtimeVersion, String(latest)), runtimeVersion, latest),
    )
  }
  const loaded: Catalog = catalog
  return loaded
})
