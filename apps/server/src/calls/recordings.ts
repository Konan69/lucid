import * as NodeURL from 'node:url'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

/**
 * Keeps the video the phone films of its own call. The phone posts encoded chunks while the call
 * runs, each appended to one file, so the recording survives the page closing mid-call and is
 * ready to edit the moment the call ends.
 *
 * DEMO RELAY: plain, unauthenticated HTTP, like the ring relay beside it. It writes only into the
 * ignored `artifacts/` directory on a local machine. Put it behind a session before exposing it.
 */

/**
 * Where recordings land: the repository's ignored `artifacts/` directory. Resolved from this
 * module rather than the process's working directory, which is the server package, not the root.
 */
const directory = NodeURL.fileURLToPath(new URL('../../../../artifacts/demo', import.meta.url))

/** A recording id names a file, so it may only be the characters the phone generates. */
const safeId = (id: string | undefined): id is string =>
  id !== undefined && /^[a-z0-9-]{3,80}\.(webm|mp4)$/.test(id)

/** Append the chunk the phone just encoded. */
const append = Effect.fn('Http.Recording.append')(function* () {
  const route = yield* HttpRouter.RouteContext
  const id = route.params.id
  if (!safeId(id)) return HttpServerResponse.jsonUnsafe({ error: 'Unknown file' }, { status: 404 })
  const request = yield* HttpServerRequest.HttpServerRequest
  const chunk = yield* request.arrayBuffer
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.makeDirectory(directory, { recursive: true })
  yield* fileSystem.writeFile(`${directory}/${id}`, new Uint8Array(chunk), { flag: 'a' })
  return HttpServerResponse.empty({ status: 204 })
})

/** Every recording held, newest first, so a finished run is easy to find. */
const list = Effect.fn('Http.Recording.list')(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const names = yield* fileSystem.readDirectory(directory).pipe(Effect.option)
  const recordings = Option.getOrElse(names, (): readonly string[] => [])
    .filter((name) => name.endsWith('.webm') || name.endsWith('.mp4'))
    .sort()
    .reverse()
  return HttpServerResponse.jsonUnsafe({ recordings, directory })
})

export const recordingRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/recordings/:id', append()),
  HttpRouter.add('GET', '/api/recordings', list()),
)
