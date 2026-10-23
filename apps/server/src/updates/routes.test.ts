import * as NodeCrypto from 'node:crypto'
import { expect, layer } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Option, Path, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import { updateRoutes } from './routes.ts'

// Mounted under a path with a trailing slash: both must survive into every address handed out.
const publicUrl = new URL('https://vivid.example/vivid/')
const bundle = 'hermes bytecode'
const image = 'png bytes'

/** One release directory as `apps/mobile/scripts/publish.mjs` leaves it, for iOS only. */
const publish = Effect.fn('Test.publish')(function* (root: string, release: string, body: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(root, release)
  yield* fs.makeDirectory(path.join(directory, 'assets'), { recursive: true })
  yield* fs.writeFileString(path.join(directory, 'index.hbc'), body)
  yield* fs.writeFileString(path.join(directory, 'assets', 'icon'), image)
  yield* fs.writeFileString(
    path.join(directory, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        ios: { bundle: 'index.hbc', assets: [{ path: 'assets/icon', ext: 'png' }] },
      },
      // The release id is the hash of this file, so each publish needs its own bytes.
      body,
    }),
  )
  yield* fs.writeFileString(
    path.join(directory, 'expoConfig.json'),
    JSON.stringify({ name: 'Vivid', extra: { kept: true } }),
  )
})

/** One part's body out of a `multipart/mixed` answer, found as expo-updates finds it: by name. */
const partBody = (body: string, name: string) => {
  const header = body.indexOf(`Content-Disposition: form-data; name="${name}"`)
  if (header === -1) return Option.none<string>()
  const start = body.indexOf('\r\n\r\n', header) + 4
  return Option.some(body.slice(start, body.indexOf('\r\n--', start)))
}

const Entry = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  fileExtension: Schema.String,
  contentType: Schema.String,
  url: Schema.String,
})
const Manifest = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  runtimeVersion: Schema.String,
  launchAsset: Entry,
  assets: Schema.Tuple([Entry]),
  metadata: Schema.Struct({}),
  extra: Schema.Struct({ expoClient: Schema.Json }),
})
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

/** Real router, filesystem and file responses, driven as expo-updates 57 drives them. */
layer(NodeHttpServer.layerTest)((it) => {
  it.effect('serves the newest release of a runtime version and the files it names', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      yield* publish(root, path.join('1.0.0', '100'), 'older')
      yield* publish(root, path.join('1.0.0', '200'), bundle)
      yield* fs.makeDirectory(path.join(root, '2.0.0'))
      // `apps/mobile/scripts/publish.mjs` publishes one export for every binary it runs on by
      // linking the older runtime versions to it.
      yield* fs.makeDirectory(path.join(root, '0.9.0'))
      yield* fs.symlink(path.join('..', '1.0.0', '200'), path.join(root, '0.9.0', '200'))
      yield* Layer.build(
        HttpRouter.serve(updateRoutes(Option.some(root), publicUrl), { disableLogger: true }),
      )
      const client = yield* HttpClient.HttpClient
      const check = (headers: Record<string, string>) =>
        client.execute(
          HttpClientRequest.get('/api/updates/manifest').pipe(
            HttpClientRequest.setHeaders(headers),
          ),
        )
      const binary = {
        'expo-protocol-version': '1',
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
      }

      const answer = yield* check(binary)
      expect(answer.status).toBe(200)
      expect(answer.headers['expo-protocol-version']).toBe('1')
      expect(answer.headers['expo-sfv-version']).toBe('0')
      const contentType = answer.headers['content-type']
      const body = yield* answer.text
      expect(contentType).toMatch(/^multipart\/mixed; boundary=vivid-/u)
      expect(partBody(body, 'extensions')).toEqual(Option.some('{"assetRequestHeaders":{}}'))
      const manifest = yield* decodeManifest(Option.getOrThrow(partBody(body, 'manifest')))
      // The newer directory wins, and its name is the update's age.
      expect(manifest.createdAt).toBe('1970-01-01T00:03:20.000Z')
      expect(manifest.runtimeVersion).toBe('1.0.0')
      expect(manifest.launchAsset.contentType).toBe('application/javascript')
      expect(manifest.launchAsset.fileExtension).toBe('.bundle')
      expect(manifest.assets[0].contentType).toBe('image/png')
      expect(manifest.assets[0].fileExtension).toBe('.png')
      // An updated app reads its Vivid's address from here; the exported config's own keys stay.
      expect(manifest.extra.expoClient).toEqual({
        name: 'Vivid',
        extra: { kept: true, server: 'https://vivid.example/vivid' },
      })

      // Every URL in the manifest downloads bytes that match the hash the app will hold them to.
      for (const [entry, bytes] of [
        [manifest.launchAsset, bundle],
        [manifest.assets[0], image],
      ] as const) {
        const url = new URL(entry.url)
        expect(url.origin).toBe(publicUrl.origin)
        expect(url.pathname).toBe('/vivid/api/updates/assets')
        // The proxy that mounts Vivid under `/vivid` strips it before the server sees the request.
        const file = yield* client.get(`/api/updates/assets${url.search}`)
        expect(file.status).toBe(200)
        expect(file.headers['content-type']).toContain(entry.contentType)
        const downloaded = yield* file.text
        expect(downloaded).toBe(bytes)
        expect(NodeCrypto.createHash('sha256').update(downloaded).digest('base64url')).toBe(
          entry.hash,
        )
      }

      // An app already on this release is told there is nothing newer.
      const current = yield* check({ ...binary, 'expo-current-update-id': manifest.id })
      const directive = yield* current.text
      expect(partBody(directive, 'directive')).toEqual(Option.some('{"type":"noUpdateAvailable"}'))
      expect(partBody(directive, 'manifest')).toEqual(Option.none())

      // An older binary the export was linked for is answered as itself: it would refuse an
      // update that names another runtime version, and its files are the same files.
      const linked = yield* check({ ...binary, 'expo-runtime-version': '0.9.0' })
      expect(linked.status).toBe(200)
      const older = yield* decodeManifest(
        Option.getOrThrow(partBody(yield* linked.text, 'manifest')),
      )
      expect(older.runtimeVersion).toBe('0.9.0')
      expect(older.id).toBe(manifest.id)
      const olderBundle = yield* client.get(
        `/api/updates/assets${new URL(older.launchAsset.url).search}`,
      )
      expect(yield* olderBundle.text).toBe(bundle)

      // A binary nothing was published for, and requests that cannot be read.
      for (const headers of [
        { ...binary, 'expo-runtime-version': '2.0.0' },
        { ...binary, 'expo-runtime-version': '9.9.9' },
        { ...binary, 'expo-platform': 'android' },
      ])
        expect((yield* check(headers)).status).toBe(404)
      for (const headers of [
        { ...binary, 'expo-platform': 'web' },
        { 'expo-platform': 'ios' },
        { ...binary, 'expo-protocol-version': '7' },
        { ...binary, 'expo-expect-signature': 'sig' },
      ])
        expect((yield* check(headers)).status).toBe(400)

      // An asset is found by key only; a path is just a key nothing has.
      const escape = yield* client.get(
        '/api/updates/assets?asset=..%2F..%2Fprivate&runtimeVersion=1.0.0&platform=ios',
      )
      expect(escape.status).toBe(404)
    }),
  )
})
