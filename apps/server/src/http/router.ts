import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { computerScreenRoutes } from '../computers/screen.ts'
import { egressRoutes } from '../computers/egress/route.ts'
import { connectionReturnRoutes } from '../connections/return.ts'
import { routineWebhookRoutes } from '../routines/webhook.ts'
import { rpcServerLayer } from '../rpc/server.ts'
import { gatewayRoutes } from '../threads/gateway.ts'
import { watchRoutes } from '../watches/receiver.ts'
import { bytesRoutes } from './bytes.ts'
import { faultRoutes } from './faults.ts'

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

/** Better Auth's own routes, as the server mounts them. Exported so a test can serve exactly this. */
export const authRoute = HttpRouter.add(
  '*',
  '/api/auth/*',
  Effect.gen(function* () {
    const auth = yield* authEffect
    // @effect-diagnostics-next-line strictEffectProvide:off -- The Layer is Alchemy's type-only `RuntimeContext.phantom` (`Layer.empty`): it acquires nothing and owns no scope, so there is no lifetime for an entry point to hold.
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
 * outside service calling a Routine's webhook, Executor delivering a Watch's events, a browser
 * moving Library bytes, the Computer's screen, a desktop app carrying the Computer's browsing
 * (`computers/egress/route.ts`), and a client reporting that it failed to draw (`faults.ts`). The
 * mobile app's update check (`updates/routes.ts`) is plain HTTP too and is added in
 * `main.ts`, because whether it exists depends on launch configuration.
 */
export const routerLayer = Layer.mergeAll(
  rpcServerLayer,
  closedRoute,
  authRoute,
  gatewayRoutes,
  bytesRoutes,
  faultRoutes,
  connectionReturnRoutes,
  routineWebhookRoutes,
  watchRoutes,
  computerScreenRoutes,
  egressRoutes,
  healthRoute,
).pipe(Layer.provide(HttpRouter.layer))
