import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import { AuthContext, AuthMiddleware, AuthState } from '@vivid/contracts/api'
import { RpcAuthMiddleware } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { authenticate } from './session.ts'

/** Both transport adapters call the same authentication program and provide the same AuthContext. */
const withAuthentication = <A, E, R>(
  headers: globalThis.Headers,
  effect: Effect.Effect<A, E, R | AuthContext>,
  services: Context.Context<Database | ServerConfig>,
) =>
  authenticate(headers).pipe(
    Effect.provideContext(services),
    Effect.flatMap((auth) => Effect.provideService(effect, AuthContext, auth)),
  )

export const authMiddlewareLayer = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | ServerConfig>()
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* withAuthentication(
          new globalThis.Headers(Object.entries(request.headers)),
          effect,
          services,
        )
      })
  }),
)

export const rpcAuthMiddlewareLayer = Layer.effect(
  RpcAuthMiddleware,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | ServerConfig>()
    const config = Context.get(services, ServerConfig)
    const runtimeAuthorization = `Bearer ${Redacted.value(config.RUNTIME_TOKEN)}`
    return (effect, options) => {
      if (options.headers.authorization === runtimeAuthorization) {
        return Effect.provideService(effect, AuthContext, AuthState.Runtime())
      }
      return withAuthentication(
        new globalThis.Headers(Object.entries(options.headers)),
        effect,
        services,
      )
    }
  }),
)
