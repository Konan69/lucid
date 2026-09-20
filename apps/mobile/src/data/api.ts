import { Effect, Layer, ManagedRuntime, Option, Schema } from 'effect'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { VividRpcClient, type VividRpcClientService } from '@vivid/client-runtime'
import { ConnectionAuthorizationResponse } from '@vivid/contracts'
import type { RpcFailure } from '@vivid/contracts/rpc'

export type Connection = { url: string; token: string }

export type RpcProgram<Value> = Effect.Effect<
  Value,
  RpcFailure | RpcClientError.RpcClientError,
  VividRpcClient
>

export type RpcOperation<Value> = (
  client: VividRpcClientService,
) => Effect.Effect<Value, RpcFailure | RpcClientError.RpcClientError>

const ErrorResponseSchema = Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponseSchema)
const ConnectionAuthorizationResponseSchema = Schema.fromJsonString(ConnectionAuthorizationResponse)
const decodeConnectionAuthorization = Schema.decodeUnknownPromise(
  ConnectionAuthorizationResponseSchema,
)
export function normalizeServerUrl(value: string) {
  const url = new URL(value.trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an http or https server address without credentials or query parameters.')
  return url.toString().replace(/\/+$/, '')
}

/** Builds the typed RPC program that acquires the generated client at the runtime boundary. */
function rpcProgram<Value>(operation: RpcOperation<Value>): RpcProgram<Value> {
  return Effect.gen(function* () {
    return yield* operation(yield* VividRpcClient)
  })
}

/** Reports a plain-fetch failure with the same sentence screens used before the RPC migration. */
async function fetchError(response: Response) {
  const result = decodeErrorResponse(await response.text())
  throw new Error(
    Option.isSome(result)
      ? result.value.error
      : `Could not reach Vivid (${response.status}). Check your server in Settings.`,
  )
}

export function createApi(connection: Connection, transport: typeof fetch = globalThis.fetch) {
  const root = normalizeServerUrl(connection.url)
  const headers: Record<string, string> = connection.token
    ? { authorization: `Bearer ${connection.token}` }
    : {}
  const rpcHeaders = connection.token === '' ? undefined : headers
  const runtime = ManagedRuntime.make(
    VividRpcClient.layer({
      url: new URL('/api/rpc', connection.url).href,
      headers: rpcHeaders,
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport)),
    ),
  )
  return {
    root,
    headers,
    // Direct runtime connections use its native route; the web gateway rewrites /api/vivid.
    agentUrl: (id: string) =>
      `${root}/${connection.token ? 'agents/vivid' : 'api/vivid'}/${encodeURIComponent(id)}`,
    rpc: rpcProgram,
    // Resource stores need the Effect itself so they own scheduling and typed failure handling.
    runEffect: <Value>(program: RpcProgram<Value>) =>
      runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provide(program, context))),
    run: <Value>(program: RpcProgram<Value>) => runtime.runPromise(program),
    async fetchBytes(path: string, init: RequestInit = {}) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        const requestHeaders = new Headers(init.headers)
        for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value)
        const response = await transport(`${root}${path}`, {
          ...init,
          headers: requestHeaders,
          signal: controller.signal,
        })
        if (!response.ok) await fetchError(response)
        return response
      } finally {
        clearTimeout(timeout)
      }
    },
    async fetchConnectionAuthorization(path: string) {
      const response = await this.fetchBytes(path)
      return decodeConnectionAuthorization(await response.text())
    },
  }
}
export type Api = ReturnType<typeof createApi>
