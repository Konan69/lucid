import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { computerScreenRoutes } from '../computers/screen.ts'
import { connectionReturnRoutes } from '../connections/return.ts'
import { routineWebhookRoutes } from '../routines/webhook.ts'
import { rpcServerLayer } from '../rpc/server.ts'
import { gatewayRoutes } from '../threads/gateway.ts'
import { bytesRoutes } from './bytes.ts'

/**
 * Better Auth's organization plugin publishes its own routes for creating Companies, inviting and
 * removing Members and listing invitations. They would be a second way to do each of those things,
 * one that skips Vivid's rules, its audit record and the notices that move open screens. The plugin
 * stays, because it is what keeps the session's active Company; its routes are answered as if they
 * did not exist. Companies and People are managed through `VividRpc` and nowhere else.
 */
const closedRoute = HttpRouter.add(
  '*',
  '/api/auth/organization/*',
  HttpServerResponse.jsonUnsafe({ message: 'Not found' }, { status: 404 }),
)

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
  closedRoute,
  authRoute,
  gatewayRoutes,
  bytesRoutes,
  connectionReturnRoutes,
  routineWebhookRoutes,
  computerScreenRoutes,
  healthRoute,
).pipe(Layer.provide(HttpRouter.layer))
