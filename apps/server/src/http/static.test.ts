import { expect, it } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { staticRoutes } from './static.ts'

/** Real router, filesystem and file responses: API specificity and HEAD semantics belong to Effect. */
it.effect('serves files and SPA routes while refusing traversal and preserving API routes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    const root = path.join(directory, 'dist')
    yield* fs.makeDirectory(path.join(root, 'assets'), { recursive: true })
    yield* fs.writeFileString(path.join(root, 'index.html'), '<html>Vivid</html>')
    yield* fs.writeFileString(path.join(root, 'assets', 'index-1234abcd.js'), 'export default 1')
    yield* fs.writeFileString(path.join(root, 'assets', 'manual-unversioned.js'), 'manual')
    yield* fs.writeFileString(path.join(directory, 'private.txt'), 'private')
    yield* fs.symlink(path.join(directory, 'private.txt'), path.join(root, 'escape.txt'))
    const routes = Layer.mergeAll(
      staticRoutes(Option.some(root)),
      HttpRouter.add('GET', '/api/test', HttpServerResponse.text('API')),
      HttpRouter.add('GET', '/health', HttpServerResponse.text('healthy')),
    )
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true }))
    const client = yield* HttpClient.HttpClient
    const get = Effect.fn('Test.staticRequest')((url: string) => client.get(url))
    const asset = yield* get('/assets/index-1234abcd.js')
    expect(yield* asset.text).toBe('export default 1')
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(asset.headers['content-type']).toContain('javascript')
    const unversioned = yield* get('/assets/manual-unversioned.js')
    expect(yield* unversioned.text).toBe('manual')
    expect(unversioned.headers['cache-control']).toBe('no-cache')
    for (const url of ['/', '/index.html', '/threads/one', '/assets/missing.js']) {
      const response = yield* get(url)
      expect(yield* response.text).toBe('<html>Vivid</html>')
      expect(response.headers['cache-control']).toBe('no-cache')
    }
    for (const url of ['/..%2Fprivate.txt', '/%5c..%5cprivate.txt', '/%00', '/escape.txt'])
      expect((yield* get(url)).status).toBe(400)
    for (const [url, body] of [
      ['/api/test', 'API'],
      ['/health', 'healthy'],
    ] as const) {
      const response = yield* get(url)
      expect(yield* response.text).toBe(body)
    }
    for (const url of ['/api', '/api/missing']) expect((yield* get(url)).status).toBe(404)
    const head = yield* client.head('/threads/one')
    expect(head.status).toBe(200)
    expect(yield* head.text).toBe('')
    const post = yield* client.post('/threads/one')
    expect(post.status).toBe(404)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)
