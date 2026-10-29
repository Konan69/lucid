import { ArtifactFileRequest, InvalidRequest } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { authenticate } from '../auth/session.ts'
import { observeFailures } from '../observability/failure.ts'
import { downloadArtifactFile } from './files.ts'

const decodeRequest = Schema.decodeUnknownEffect(ArtifactFileRequest)

/** Byte routes accept the same cookie/bearer Person identity as other authenticated downloads. */
const content = Effect.fn('Http.Artifact.content')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const auth = yield* authenticate(new Headers(Object.entries(request.headers)))
  const { params } = yield* HttpRouter.RouteContext
  const input = yield* decodeRequest({
    id: params.id,
    version: Number(params.number),
    role: params.role,
  }).pipe(Effect.mapError(() => new InvalidRequest({ message: 'Invalid Artifact file address' })))
  const { file, bytes } = yield* downloadArtifactFile(auth.person.id, input)
  // Only inert raster/PDF previews may display inline. HTML, SVG and all other files download.
  const disposition = ['image/png', 'image/jpeg', 'application/pdf'].includes(file.mimeType)
    ? 'inline'
    : 'attachment'
  return HttpServerResponse.uint8Array(bytes, {
    contentType: file.mimeType,
    headers: {
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
})

/** Authentication and Thread isolation refuse the request before any bytes leave storage. */
export const artifactBytesRoutes = HttpRouter.add(
  'GET',
  '/api/artifacts/:id/versions/:number/files/:role',
  content().pipe(
    observeFailures('http'),
    Effect.catchTags({
      Unauthenticated: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      Forbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      NotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ArtifactNotEditable: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      InvalidRequest: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
  ),
)
