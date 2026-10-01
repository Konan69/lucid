import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Headers from 'effect/unstable/http/Headers'
import { AuthContext, AuthState, runtimeHeaders } from '@vivid/contracts/auth'
import { RpcAuthMiddleware } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { authenticate, authenticateVivid } from './session.ts'

/**
 * Decides who is calling, once, for every product call.
 *
 * - A Better Auth session (a browser cookie, or the bearer token a paired device holds) is a
 *   Person.
 * - The runtime token with the Thread and actor headers is Vivid acting for that Person.
 * - The runtime token alone is the runtime itself, which may call nothing that needs an owner.
 *
 * The runtime token is compared before any session lookup so that a tool call never reaches
 * Better Auth with a token that is not a session.
 */
export const rpcAuthMiddlewareLayer = Layer.effect(
  RpcAuthMiddleware,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | ServerConfig>()
    const config = Context.get(services, ServerConfig)
    const runtimeAuthorization = `Bearer ${Redacted.value(config.RUNTIME_TOKEN)}`
    const identify = Effect.fn('Auth.identify')(function* (headers: Headers.Headers) {
      if (headers.authorization === runtimeAuthorization) return yield* runtimeIdentity(headers)
      return yield* authenticate(new globalThis.Headers(Object.entries(headers)))
    })
    return (effect, options) =>
      identify(options.headers).pipe(
        Effect.provideContext(services),
        Effect.flatMap((auth) => Effect.provideService(effect, AuthContext, auth)),
      )
  }),
)

/** Vivid acting for a Person when both headers are present; otherwise the bare runtime. */
const runtimeIdentity = (headers: Headers.Headers) => {
  const thread = Headers.get(headers, runtimeHeaders.thread)
  const actor = Headers.get(headers, runtimeHeaders.actor)
  if (Option.isNone(thread) || Option.isNone(actor)) return Effect.succeed(AuthState.Runtime())
  return authenticateVivid({ thread: thread.value, actor: actor.value })
}
