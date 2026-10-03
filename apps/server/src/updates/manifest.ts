import { Option, Schema } from 'effect'
import type { Catalog, Platform, Release, ReleaseFile } from './release.ts'

/**
 * What the app is told when it asks for an update, as the Expo Updates protocol defines it.
 *
 * Ported from `expo-updates-server/pages/api/manifest.ts` (`putUpdateInResponseAsync`,
 * `putNoUpdateAvailableInResponseAsync`) in expo/custom-expo-updates-server. The client that reads
 * the answer is expo-updates 57 (`ios/EXUpdates/AppLoader/FileDownloader.swift`).
 */

/** What one check for an update says about the binary asking. */
export interface UpdateRequest {
  /** `expo-protocol-version`. Version 0 has no directives and is always sent the manifest. */
  readonly protocolVersion: number
  readonly platform: Platform
  readonly runtimeVersion: string
  /** `expo-current-update-id`: the update the app is running now, when it says. */
  readonly currentUpdateId: Option.Option<string>
}

const Entry = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  fileExtension: Schema.String,
  contentType: Schema.String,
  url: Schema.String,
})

/**
 * The parts a `multipart/mixed` answer is made of, each name tied to the one body it may carry.
 * The app reads a part by its name: `manifest` is an update to download and comes with
 * `extensions`; `directive` is an instruction instead of an update and comes alone. The reference
 * fills `assetRequestHeaders` with a demonstration header; these assets need none.
 */
export const UpdatePart = Schema.Union([
  Schema.Struct({
    name: Schema.Literal('manifest'),
    body: Schema.Struct({
      id: Schema.String,
      createdAt: Schema.String,
      runtimeVersion: Schema.String,
      assets: Schema.Array(Entry),
      launchAsset: Entry,
      metadata: Schema.Struct({}),
      extra: Schema.Struct({ expoClient: Schema.Record(Schema.String, Schema.Json) }),
    }),
  }),
  Schema.Struct({
    name: Schema.Literal('extensions'),
    body: Schema.Struct({ assetRequestHeaders: Schema.Struct({}) }),
  }),
  Schema.Struct({
    name: Schema.Literal('directive'),
    body: Schema.Struct({ type: Schema.Literal('noUpdateAvailable') }),
  }),
])
export type UpdatePart = typeof UpdatePart.Type

/**
 * The address everything is built on: the server's public URL without a trailing slash, query or
 * hash. A Vivid mounted under a path (`https://host/vivid`) keeps that path, which is how the app
 * reads the same address (`apps/mobile/src/data/server.ts:parseServer`).
 */
const baseOf = (publicUrl: URL) => `${publicUrl.origin}${publicUrl.pathname.replace(/\/+$/u, '')}`

/** Where the app downloads one file. The file is named by its `key`, never by a path. */
const assetUrl = (publicUrl: URL, request: UpdateRequest, file: ReleaseFile) => {
  const url = new URL(`${baseOf(publicUrl)}/api/updates/assets`)
  url.searchParams.set('asset', file.key)
  url.searchParams.set('runtimeVersion', request.runtimeVersion)
  url.searchParams.set('platform', request.platform)
  return url.toString()
}

const assetEntry = (publicUrl: URL, request: UpdateRequest, file: ReleaseFile) => ({
  hash: file.hash,
  key: file.key,
  fileExtension: file.fileExtension,
  contentType: file.contentType,
  url: assetUrl(publicUrl, request, file),
})

/**
 * `extra.expoClient` becomes the running app's Expo config, replacing the one built into the
 * binary. The app finds its Vivid in that config's `extra.server` (`apps/mobile/src/data/origin.ts`),
 * which a build is given from outside and an export made with the server image never had. The
 * server answering is that Vivid, so it states its own public address here; without it an updated
 * app would no longer know where to sign in.
 */
const expoClient = (publicUrl: URL, release: Release) => ({
  ...release.expoConfig,
  extra: { ...release.expoConfig.extra, server: baseOf(publicUrl) },
})

/** The release for a binary and its files for one platform, when both are published. */
const published = (catalog: Catalog, runtimeVersion: string, platform: Platform) =>
  Option.flatMap(Option.fromUndefinedOr(catalog.get(runtimeVersion)), (release) =>
    Option.map(Option.fromUndefinedOr(release.platforms.get(platform)), (files) => ({
      release,
      files,
    })),
  )

/**
 * The parts of the answer for one request, or None when nothing is published for that binary: an
 * unknown runtime version, or a release exported without the platform asking.
 *
 * An app already running the newest release is told so with a `noUpdateAvailable` directive, which
 * exists only from protocol version 1; a version 0 client is sent the manifest again, as the
 * reference does.
 */
export const answerUpdate = (
  catalog: Catalog,
  publicUrl: URL,
  request: UpdateRequest,
): Option.Option<ReadonlyArray<UpdatePart>> =>
  Option.map(
    published(catalog, request.runtimeVersion, request.platform),
    ({ release, files }): ReadonlyArray<UpdatePart> => {
      const current = Option.contains(request.currentUpdateId, release.id)
      if (current && request.protocolVersion === 1)
        return [{ name: 'directive', body: { type: 'noUpdateAvailable' } }]
      return [
        {
          name: 'manifest',
          body: {
            id: release.id,
            createdAt: release.createdAt,
            runtimeVersion: release.runtimeVersion,
            assets: files.assets.map((file) => assetEntry(publicUrl, request, file)),
            launchAsset: assetEntry(publicUrl, request, files.launchAsset),
            metadata: {},
            extra: { expoClient: expoClient(publicUrl, release) },
          },
        },
        { name: 'extensions', body: { assetRequestHeaders: {} } },
      ]
    },
  )

/**
 * The file one asset URL names. Only a file listed in the release can be found, because the
 * lookup is by `key` among them; the reference resolves the request's `asset` as a path and would
 * read any file the process can.
 */
export const findAsset = (
  catalog: Catalog,
  target: { readonly runtimeVersion: string; readonly platform: Platform; readonly key: string },
): Option.Option<ReleaseFile> =>
  Option.flatMap(published(catalog, target.runtimeVersion, target.platform), ({ files }) =>
    Option.fromUndefinedOr(
      [files.launchAsset, ...files.assets].find((file) => file.key === target.key),
    ),
  )
