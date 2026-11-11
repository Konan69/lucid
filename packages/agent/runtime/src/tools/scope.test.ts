import { unusedMemory, unusedTranscripts } from './tests/harness.ts'
import * as NodeHttp from 'node:http'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import { VividRpcClient } from '@vivid/client-runtime'
import { PersonId, ReadPageRequest, ReadPageOutcome, ThreadId } from '@vivid/contracts'
import { AuthContext, AuthState, runtimeHeaders } from '@vivid/contracts/auth'
import { RpcAuthMiddleware, RpcFailure } from '@vivid/contracts/rpc'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import { Product, productLayer } from '../client.ts'
import { RuntimeSettings } from '../settings.ts'
import { tools } from './index.ts'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { codeTools } from './code.ts'
import { NobodyToActFor } from '../client.ts'
import { Scope, toolRunner } from './scope.ts'
import { invoke } from './tests/harness.ts'

/** Authority acquisition fails inside the same settled scope as execution; no model input can
 * manufacture a client when the core has no acting Person for this call. */
describe('explicit tool authority', () => {
  it.effect('settles missing attribution before tools can access the RPC client', () =>
    Effect.gen(function* () {
      const layer = Layer.effect(
        Scope,
        Effect.fail(new NobodyToActFor({ message: 'No Person for this call.' })),
      )
      const [, page] = codeTools(toolRunner(layer))
      const result = yield* Effect.promise(() =>
        invoke(page, {
          data: { summary: 'Read the page', address: 'https://example.test' },
          signal: new AbortController().signal,
        }),
      )
      expect(result).toEqual({
        output: {
          ok: false,
          message: 'There is no person behind this message to act for.',
          tell_them: 'something went wrong with that message. could you send it again?',
        },
        terminate: false,
      })
    }),
  )
})

/** The core supplies a resolver, while the real attributed HTTP client owns wire headers and
 * transport lifetime. Pi must keep that Layer alive until the tool's receipt is persisted. */
it.live('keeps the resolver’s Person and Thread attribution on the HTTP RPC call', () =>
  Effect.gen(function* () {
    const headers: Record<string, string>[] = []
    const group = RpcGroup.make(
      Rpc.make('ReadPage', {
        payload: ReadPageRequest,
        success: ReadPageOutcome,
        error: RpcFailure,
      }),
    ).middleware(RpcAuthMiddleware)
    const routes = RpcServer.layerHttp({ group, path: '/api/rpc', protocol: 'http' }).pipe(
      Layer.provide(
        group.toLayer({
          ReadPage: () =>
            Effect.succeed(
              ReadPageOutcome.cases.Read.make({
                address: 'https://example.test',
                title: 'Example',
                text: 'Page',
                truncated: false,
                pictures: [],
              }),
            ),
        }),
      ),
      Layer.provide(
        Layer.succeed(RpcAuthMiddleware, (effect, options) => {
          headers.push(options.headers)
          return Effect.provideService(effect, AuthContext, AuthState.Runtime())
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    )
    const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: '127.0.0.1', port: 0 }),
      ),
    )
    yield* Effect.gen(function* () {
      const product = yield* Product
      const acting = {
        personId: PersonId.make('scope-person'),
        threadId: ThreadId.make('scope-thread'),
      }
      const definitions = tools(
        () =>
          Layer.effect(
            Scope,
            Effect.gen(function* () {
              return Scope.of({ acting, client: yield* VividRpcClient, timezone: '' })
            }),
          ).pipe(Layer.provide(product.as(acting))),
        () => Effect.die('Unexpected memory authority'),
        { memory: unusedMemory, transcripts: unusedTranscripts },
        { skills: [], children: [] },
      ).tools
      const page = definitions.find((tool) => tool.name === 'read_page')
      if (page === undefined) expect.fail('Missing read_page tool.')
      const receipt = yield* Effect.promise(() =>
        invoke(page, {
          data: { summary: 'Read the page', address: 'https://example.test' },
          signal: new AbortController().signal,
        }),
      )
      expect(receipt.output).toMatchObject({ ok: true, title: 'Example' })
      expect(headers).toHaveLength(1)
      expect(headers[0]).toMatchObject({
        authorization: 'Bearer test-runtime-token',
        [runtimeHeaders.actor]: 'scope-person',
        [runtimeHeaders.thread]: 'scope-thread',
      })
      expect(JSON.stringify(receipt)).not.toMatch(/scope-person|scope-thread|test-runtime-token/)
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- This live test is the HTTP fixture entry point and owns both server and client scopes.
      Effect.provide(
        productLayer.pipe(
          Layer.provide(
            Layer.effect(
              RuntimeSettings,
              Effect.gen(function* () {
                return RuntimeSettings.of({
                  serverUrl: new URL(
                    HttpServer.formatAddress((yield* HttpServer.HttpServer).address),
                  ),
                  token: Redacted.make('test-runtime-token'),
                })
              }),
            ),
          ),
          Layer.provide(NodeHttpClient.layerUndici),
        ),
      ),
      Effect.provide(yield* Layer.build(server)),
    )
  }).pipe(Effect.scoped),
)
