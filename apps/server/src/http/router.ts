import { activityActionRoutes } from '../activity/actions.ts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { Auth, AuthUnavailable } from '../auth/provider.ts'
import { artifactBytesRoutes } from '../artifacts/bytes.ts'
import { computerScreenRoutes } from '../computers/screen.ts'
import { egressRoutes } from '../computers/egress/route.ts'
import { connectionReturnRoutes } from '../connections/return.ts'
import { rpcServerLayer } from '../rpc/server.ts'
import { CellContract, CellContractReading } from '../runtime/contract.ts'
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
    const auth = yield* Auth
    const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest)
    // Better Auth answers its own refusals as responses; a rejection is a fault inside it.
    const response = yield* Effect.tryPromise({
      try: () => auth.handler(request),
      catch: () => new AuthUnavailable({}),
    })
    return HttpServerResponse.fromWeb(response)
  }),
)

/**
 * Readiness, as Railway reads it before this deployment takes traffic (`infra/railway.ts`
 * `healthcheckPath`). Not ready only when the cells answered and were built from other wire
 * schemas (`Mismatched`, or `Unanswered` from a Worker older than `/contract`): that is a broken
 * pairing, so the deploy fails with the reason and the previous deployment keeps serving.
 *
 * Cells that cannot be reached do not make the server unready. They start after the server in a
 * fresh stack (they are given its address), and a cell outage must not take sign-in, Threads and
 * Settings down with it; sends then fail as `RuntimeUnavailable`, each one a recorded Incident,
 * and the reading is logged at error. The first `verify launch` of this change deadlocked on that
 * ordering.
 */
export const healthRoute = HttpRouter.add(
  'GET',
  '/health',
  Effect.gen(function* () {
    const reading = yield* (yield* CellContract).read
    return CellContractReading.match(reading, {
      Matched: () => HttpServerResponse.jsonUnsafe({ ok: true, service: 'vivid' }),
      Unreachable: () =>
        HttpServerResponse.jsonUnsafe({ ok: true, service: 'vivid', contract: reading }),
      Mismatched: () =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, service: 'vivid', contract: reading },
          { status: 503 },
        ),
      Unanswered: () =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, service: 'vivid', contract: reading },
          { status: 503 },
        ),
    })
  }),
)

/**
 * Everything the server answers. Product calls are `VividRpc` (`/api/live`, `/api/rpc`). The rest
 * is plain HTTP only where something other than our client is on the other end: Better Auth, the
 * conversation client talking to the runtime gateway, a provider redirecting back after sign-in, Executor delivering Watch events, a browser
 * moving Library bytes, the Computer's screen, a desktop app carrying the Computer's browsing
 * (`computers/egress/route.ts`), and a client reporting that it failed to draw (`faults.ts`). The
 * mobile app's update check (`updates/routes.ts`) is plain HTTP too and is added in
 * `main.ts`, because whether it exists depends on launch configuration.
 */
export const routerLayer = Layer.mergeAll(
  activityActionRoutes,
  rpcServerLayer,
  closedRoute,
  authRoute,
  gatewayRoutes,
  bytesRoutes,
  artifactBytesRoutes,
  faultRoutes,
  connectionReturnRoutes,
  watchRoutes,
  computerScreenRoutes,
  egressRoutes,
  healthRoute,
).pipe(Layer.provide(HttpRouter.layer))
