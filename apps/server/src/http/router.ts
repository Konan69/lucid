import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { recordingRoutes } from '../calls/recordings.ts'
import { ringRoutes } from '../calls/ring.ts'
import { computerScreenRoutes } from '../computers/screen.ts'
import { connectionReturnRoutes } from '../connections/return.ts'
import { routineWebhookRoutes } from '../routines/webhook.ts'
import { rpcServerLayer } from '../rpc/server.ts'
import { gatewayRoutes } from '../threads/gateway.ts'
import { bytesRoutes } from './bytes.ts'

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

/**
 * Everything the server answers. Product calls are `VividRpc` (`/api/live`, `/api/rpc`). The rest
 * is plain HTTP only where something other than our client is on the other end: Better Auth, the
 * Flue client talking to the conversation gateway, a provider redirecting back after sign-in, an
 * outside service calling a Routine's webhook, a browser moving Library bytes, and the Computer's
 * screen.
 */
export const routerLayer = Layer.mergeAll(
  rpcServerLayer,
  authRoute,
  gatewayRoutes,
  bytesRoutes,
  connectionReturnRoutes,
  routineWebhookRoutes,
  computerScreenRoutes,
  ringRoutes,
  recordingRoutes,
  healthRoute,
).pipe(Layer.provide(HttpRouter.layer))
