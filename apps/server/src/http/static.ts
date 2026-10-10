import { Effect, FileSystem, Layer, Option, Path, Schema } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

/** Invalid URL encoding or a traversal attempt is a client error, never an SPA route. */
class StaticPathRejected extends Schema.TaggedError<StaticPathRejected>()(
  'StaticPathRejected',
  {},
  { title: 'Static path rejected' },
) {}

/** Decode once before resolution; encoded separators and Windows separators cannot escape the root. */
const pathname = Effect.fn('Static.pathname')(function* (url: string) {
  const decoded = yield* Effect.try({
    try: () => decodeURIComponent(url.slice(0, url.includes('?') ? url.indexOf('?') : url.length)),
    catch: () => new StaticPathRejected({}),
  })
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..'))
    return yield* new StaticPathRejected({})
  return decoded
})

/** Both lexical resolution and symlink resolution must stay beneath the canonical dist directory. */
const contained = Effect.fn('Static.contained')(function* (root: string, candidate: string) {
  const path = yield* Path.Path
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return yield* new StaticPathRejected({})
  return candidate
})

/** Only real regular files are hits. A missing route/directory uses the SPA document; I/O failures stay failures. */
const exactFile = Effect.fn('Static.exactFile')(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidate = yield* contained(root, path.resolve(root, `.${name}`))
  if (!(yield* fs.exists(candidate))) return Option.none<string>()
  const real = yield* contained(root, yield* fs.realPath(candidate))
  const info = yield* fs.stat(real)
  return info.type === 'File' ? Option.some(real) : Option.none<string>()
})

/**
 * effect/src/unstable/http/HttpRouter.ts:make/asHttpEffect (rc.116) supplies HEAD through GET and
 * prefers concrete routes over /*. HttpServerResponse.ts:file delegates streaming, MIME, length
 * and ETag to @effect/platform-node/src/NodeHttpPlatform.ts:make;
 * no custom body buffering or dependency is needed. Reserved namespaces and upgrades cannot
 * fall through to the SPA even when no matching API endpoint exists.
 */
export function staticRoutes(directory: Option.Option<string>) {
  if (Option.isNone(directory)) return Layer.empty
  return HttpRouter.use(
    Effect.fn('Static.register')(function* (router) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.realPath(directory.value)
      const index = yield* contained(root, yield* fs.realPath(path.join(root, 'index.html')))
      yield* router.add(
        'GET',
        '/*',
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* pathname(request.url)
          if (
            name === '/api' ||
            name.startsWith('/api/') ||
            name === '/health' ||
            request.headers.upgrade !== undefined
          )
            return HttpServerResponse.empty({ status: 404 })
          const file = Option.getOrElse(yield* exactFile(root, name), () => index)
          // Vite's default asset names include an eight-character content hash. Unversioned files revalidate.
          const hashed = name.startsWith('/assets/') && /-[\w-]{8}\.[\w.]+$/u.test(name)
          const cache =
            file !== index && hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
          return yield* HttpServerResponse.file(file, { headers: { 'cache-control': cache } })
        }).pipe(
          Effect.withSpan('Static.serve'),
          Effect.catchTag('StaticPathRejected', () =>
            Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          ),
        ),
      )
    }),
  )
}
