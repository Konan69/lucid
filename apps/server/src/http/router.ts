import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { recordingRoutes } from '../calls/recordings.ts'
import { ringRoutes } from '../calls/ring.ts'
import { rpcServerLayer } from '../rpc/server.ts'
import { apiLayer } from './api.ts'
import { bytesRoutes } from './bytes.ts'
import { oauthRoutes } from './oauth.ts'

const authRoute = HttpRouter.add(
  '*',
  '/api/auth/*',
  Effect.gen(function* () {
    const auth = yield* authEffect
    return yield* auth.fetch.pipe(Effect.provide(localAuthRuntimeLayer))
  }),
)

const healthRoute = HttpRouter.add(
  'GET',
  '/health',
  HttpServerResponse.jsonUnsafe({ ok: true, service: 'vivid' }),
)

export const routerLayer = Layer.mergeAll(
  apiLayer,
  rpcServerLayer,
  authRoute,
  bytesRoutes,
  oauthRoutes,
  ringRoutes,
  recordingRoutes,
  healthRoute,
).pipe(Layer.provide(HttpRouter.layer))
