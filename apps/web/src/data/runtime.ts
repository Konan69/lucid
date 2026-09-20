import { VividRpcClient } from '@vivid/client-runtime'
import { Effect, Layer, ManagedRuntime } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import type * as Result from 'effect/Result'
import type { RpcFailure } from '@vivid/contracts/rpc'

/** Failures shared by generated RPC calls and the browser-only byte/OAuth adapters. */
export type ProductFailure = RpcFailure | RpcClientError.RpcClientError

/** Effect program accepted by the web runtime boundary. */
export type Program<Value> = Effect.Effect<Value, ProductFailure, VividRpcClient>

/** Converts a browser-only transport failure into the same client failure screens already render. */
export function clientFailure(message: string, cause: unknown): RpcClientError.RpcClientError {
  return RpcClientError.RpcClientError.make({
    reason: RpcClientError.RpcClientDefect.make({ message, cause }),
  })
}

// The web application owns one long-lived generated client. Fetch stays below the client so all
// product calls share the RPC protocol, contract decoding, and browser same-origin credentials.
const runtimeLayer = VividRpcClient.layer({ url: '/api/rpc' }).pipe(
  Layer.provide(FetchHttpClient.layer),
)
const runtime = ManagedRuntime.make(runtimeLayer)

/** Executes a client program at the web application's single Effect runtime boundary. */
export function run<Value, Failure>(
  program: Effect.Effect<Value, Failure, VividRpcClient>,
): Promise<Result.Result<Value, Failure>> {
  return runtime.runPromise(Effect.result(program))
}
