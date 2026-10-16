import { describe, expect, it } from '@effect/vitest'
import * as NodeHttp from 'node:http'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import { ConfigProvider, Effect, Layer, Option } from 'effect'
import {
  DeliveryScope,
  LibraryFolderId,
  PersonId,
  ReadPageOutcome,
  ReadPageRequest,
  ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState, runtimeHeaders } from '@vivid/contracts/auth'
import { RpcAuthMiddleware, RpcFailure } from '@vivid/contracts/rpc'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import { scopeLayer, Scope } from './scope.ts'
import { cachedAuthority, recordScope } from '../delivery.ts'
import { searchRequest } from './library.ts'
import { settle } from './result.ts'
import { codeTools } from './code.ts'
import { toolRunner } from './scope.ts'
import { asActing } from '../client.ts'

const folder = '3a1c68db-241e-4b59-a0aa-4b18867d6da1'

/** Server scope is decoded independently of model input, with absent and malformed deliveries safe. */
describe('Library authority', () => {
  it.live('keeps the attributed HTTP RPC client alive until the Flue tool finishes', () =>
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
                  address: 'https://example.com',
                  title: 'Example Domain',
                  text: 'Example',
                  truncated: false,
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
        const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
        const config = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VIVID_SERVER_URL: address,
            VIVID_RUNTIME_TOKEN: 'test-runtime-token',
          }),
        )
        const scope = scopeLayer(
          'test-thread',
          { kind: 'user', body: 'Read it.' },
          Option.some({ creator: PersonId.make('test-person'), creatorName: 'Test' }),
        ).pipe(Layer.provide(config))
        const [, page] = codeTools(toolRunner(scope))
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            page.run({
              data: { summary: 'Example page', address: 'https://example.com' },
              signal: new AbortController().signal,
              toolCallId: 'test-call',
              log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
            }),
          ),
        )
        expect(result).toMatchObject({ output: { ok: true, title: 'Example Domain' } })
        expect(headers).toHaveLength(1)
        expect(headers[0]).toMatchObject({
          authorization: 'Bearer test-runtime-token',
          [runtimeHeaders.thread]: 'test-thread',
          [runtimeHeaders.actor]: 'test-person',
        })
        // Separate reads inside the server's longer scope must acquire distinct attributed clients.
        yield* Effect.gen(function* () {
          const clients: object[] = []
          for (let call = 0; call < 2; call++) {
            const result = yield* asActing(
              Option.some({
                threadId: ThreadId.make('test-thread'),
                personId: PersonId.make('test-person'),
              }),
              (client) => {
                clients.push(client)
                return client.ReadPage({ address: 'https://example.com' })
              },
            )
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- This partial assertion matches the response tag and title; it does not construct a domain value.
            expect(result).toMatchObject({ _tag: 'Read', title: 'Example Domain' })
          }
          expect(clients[0]).not.toBe(clients[1])
          expect(headers).toHaveLength(3)
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              VIVID_SERVER_URL: address,
              VIVID_RUNTIME_TOKEN: 'test-runtime-token',
            }),
          ),
        )
      }).pipe(Effect.provide(yield* Layer.build(server)))
    }),
  )
  it('uses only a valid server signal folder and puts it in the search request', () => {
    const threadId = ThreadId.make('scope-test-thread')
    recordScope(
      threadId,
      1,
      DeliveryScope.make({
        acting: PersonId.make('MARK-person'),
        libraryFolder: LibraryFolderId.make(folder),
      }),
    )
    const delivery = {
      kind: 'signal' as const,
      type: 'event',
      body: 'Search.',
      attributes: { turn: '1' },
    }
    const decoded = Option.map(
      cachedAuthority(threadId, delivery, Option.none()),
      (scope) => scope.folder,
    )
    expect(decoded).toEqual(Option.some(Option.some(LibraryFolderId.make(folder))))
    expect(searchRequest({ query: 'Sources', limit: 6 }, Option.flatten(decoded))).toEqual({
      query: 'Sources',
      limit: 6,
      folderId: folder,
    })
    for (const libraryFolder of [null, LibraryFolderId.make('malformed')]) {
      expect(
        recordScope(
          threadId,
          2,
          DeliveryScope.make({ acting: PersonId.make('MARK-person'), libraryFolder }),
        ).folder,
      ).toEqual(Option.none())
    }
    expect(searchRequest({ query: 'Sources', limit: 6 }, Option.none())).toEqual({
      query: 'Sources',
      limit: 6,
    })
  })
  it.effect('settles missing attribution before tools can access the RPC client', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        // Acquisition failure remains inside settle, just like the tool boundary.
        const context = yield* Layer.build(
          scopeLayer('thread', { kind: 'user', body: 'Do it.' }, Option.none()),
        )
        return yield* Effect.gen(function* () {
          yield* Scope
          return { output: { ok: true } }
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped)
      expect((yield* settle(program, 'test-tool')).output).toEqual({
        ok: false,
        message: 'There is no person behind this message to act for.',
      })
    }),
  )
})
