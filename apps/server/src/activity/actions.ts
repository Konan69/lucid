import { Schema, Effect } from 'effect'
import { AuthContext } from '@vivid/contracts/auth'
import { ActivityAction } from '@vivid/contracts'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { authenticate } from '../auth/session.ts'
import { threadHandlers } from '../threads/handlers.ts'
import { approvalHandlers } from '../approvals/handlers.ts'

const decodeAction = Schema.decodeUnknownEffect(ActivityAction)

/** Native intents use the same handlers and digest checks as the signed-in product. */
export const activityActionRoutes = HttpRouter.add(
  'POST',
  '/api/activity/action',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const authorization = request.headers['authorization']
    if (authorization === undefined || !authorization.startsWith('Bearer '))
      return HttpServerResponse.empty({ status: 401 })
    const auth = yield* authenticate(new Headers(Object.entries(request.headers)))
    const action = yield* decodeAction(yield* request.json)
    if (ActivityAction.guards.Reply(action)) {
      yield* threadHandlers
        .SendToThread(action.request)
        .pipe(Effect.provideService(AuthContext, auth))
    } else {
      yield* approvalHandlers
        .DecideApproval(action.request)
        .pipe(Effect.provideService(AuthContext, auth))
    }
    return HttpServerResponse.empty({ status: 204 })
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning('Native notification action refused', { reason: error._tag }).pipe(
        Effect.as(HttpServerResponse.empty({ status: 400 })),
      ),
    ),
  ),
)
