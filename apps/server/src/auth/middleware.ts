import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Headers from 'effect/http/Headers'
import { AuthContext, AuthState, runtimeHeaders } from '@vivid/contracts/auth'
import { RpcAuthMiddleware } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { observeFailures } from '../observability/failure.ts'
import { Auth } from './provider.ts'
import { authenticate, authenticateHelper, authenticateVivid } from './session.ts'

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
    // Effect.context returns the entire build context, including Layer.effect's Scope (rc.116
    // Layer.ts effectContext). Keep only the authorities a call needs, so nothing the call
    // acquires is tied to this Layer's scope instead of the call's own.
    const services = Context.pick(
      Auth,
      Database,
      ServerConfig,
    )(yield* Effect.context<Auth | Database | ServerConfig>())
    const config = Context.get(services, ServerConfig)
    const runtimeAuthorization = `Bearer ${Redacted.value(config.RUNTIME_TOKEN)}`
    const identify = Effect.fn('Auth.identify')(function* (headers: Headers.Headers) {
      if (headers.authorization === runtimeAuthorization) return yield* runtimeIdentity(headers)
      return yield* authenticate(new globalThis.Headers(Object.entries(headers)))
    })
    // Every product call carries this middleware (`VividRpc.middleware` in the contract), and
    // Effect 4.0.2 `RpcServer.ts` runs it inside the call's span (named by its tag), around the handler
    // and before the exit is encoded for the client. So this is the one place that sees every
    // call's failure once, sign-in refusals included, with the call's own span current.
    return (effect, options) =>
      identify(options.headers).pipe(
        Effect.provideContext(services),
        Effect.flatMap((auth) => Effect.provideService(effect, AuthContext, auth)),
        observeFailures('rpc'),
      )
  }),
)

/**
 * Vivid acting for a Person when both headers are present, a helper Run when the helper header
 * is there too; otherwise the bare runtime.
 */
const runtimeIdentity = (headers: Headers.Headers) => {
  const thread = Headers.get(headers, runtimeHeaders.thread)
  const actor = Headers.get(headers, runtimeHeaders.actor)
  if (Option.isNone(thread) || Option.isNone(actor)) return Effect.succeed(AuthState.Runtime())
  const helper = Headers.get(headers, runtimeHeaders.helper)
  if (Option.isSome(helper))
    return authenticateHelper({ thread: thread.value, actor: actor.value, helper: helper.value })
  return authenticateVivid({ thread: thread.value, actor: actor.value })
}
