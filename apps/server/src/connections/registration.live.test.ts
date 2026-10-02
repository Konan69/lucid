import * as NodeHttp from 'node:http'
import * as NodeProcess from 'node:process'
import { NodeHttpServer, NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { AddIntegrationOutcome, ConnectionId, SessionId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import { eq } from 'drizzle-orm'
import { executorLayer } from './executor.ts'
import { ConnectionAddress, ConnectionSource } from './address.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionHandlers } from './handlers.ts'
import { connectionTestLayer, ConnectionProbe, fixture } from './testing.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { Database } from '../database/client.ts'

const executorUrl = NodeProcess.env['VIVID_TEST_EXECUTOR_URL']
const executorKey = NodeProcess.env['VIVID_TEST_EXECUTOR_KEY']
const enabled =
  NodeProcess.env['VIVID_LIVE_INTEGRATIONS'] === '1' &&
  executorUrl !== undefined &&
  executorKey !== undefined &&
  NodeProcess.env['VIVID_TEST_DATABASE_URL'] !== undefined
const liveExecutor = executorLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        VIVID_EXECUTOR_URL: executorUrl,
        VIVID_EXECUTOR_KEY: executorKey,
        // The test explicitly supplies local sources; production's URL policy is tested separately.
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)
const Request = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
})
const decodeRequest = Schema.decodeUnknownEffect(Request)

/** URL imports carry an absolute API base so this fixture tests the provider call too. */
const specification = (address: string) => {
  return {
    openapi: '3.0.3',
    info: { title: 'Fixture', version: '1' },
    servers: [{ url: `${address}/api` }],
    paths: {
      '/health': {
        get: { operationId: 'health', responses: { '200': { description: 'Healthy' } } },
      },
    },
  }
}

/** A real MCP endpoint requires a Bearer token for initialization, discovery and invocation.
 * It records only whether the correct header arrived; the credential itself is never retained.
 */
const upstream = Effect.fn('IntegrationLive.upstream')(function* (secret: string) {
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('Expected TCP fixture')
  const address = (yield* Effect.fromResult(NetAddress.toUrl(server.address))).href.replace(
    /\/$/u,
    '',
  )
  const called = yield* Ref.make(0)
  const handler = Effect.fn('IntegrationLive.request')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url === '/spec') return HttpServerResponse.jsonUnsafe(specification(address))
    if (request.url === '/api/health') {
      yield* Ref.update(called, (count) => count + 1)
      return HttpServerResponse.jsonUnsafe({ ok: true })
    }
    if (request.headers.authorization !== `Bearer ${secret}`)
      return HttpServerResponse.empty({ status: 401, headers: { 'www-authenticate': 'Bearer' } })
    if (request.method === 'GET') return HttpServerResponse.empty({ status: 405 })
    const input = yield* request.json.pipe(Effect.flatMap(decodeRequest))
    if (input.id === undefined) return HttpServerResponse.empty({ status: 202 })
    if (input.method === 'initialize')
      return HttpServerResponse.jsonUnsafe({
        jsonrpc: '2.0',
        id: input.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'Fixture', version: '1' },
        },
      })
    if (input.method === 'tools/list')
      return HttpServerResponse.jsonUnsafe({
        jsonrpc: '2.0',
        id: input.id,
        result: {
          tools: [
            {
              name: 'health',
              description: 'Read-only health',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      })
    if (input.method === 'tools/call') {
      yield* Ref.update(called, (count) => count + 1)
      // Deliberate echo proves test_integration never returns provider data to model context.
      return HttpServerResponse.jsonUnsafe({
        jsonrpc: '2.0',
        id: input.id,
        result: { content: [{ type: 'text', text: secret }] },
      })
    }
    return HttpServerResponse.empty({ status: 400 })
  })
  yield* server.serve(handler())
  return { address, called }
})

/** Real Executor owns registration, credential storage and header injection. Local sources are a
 * deliberate test-only authority Layer; no production URL exception or live app database is used.
 */
describe.skipIf(!enabled)('Executor integration registration', () => {
  for (const kind of ['Mcp', 'OpenApi'] as const) {
    it.effect(
      `imports ${kind}, tests one read, and keeps the key out of views and audit rows`,
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor, threadId } = yield* fixture()
          const secret = `integration-fixture-${crypto.randomUUID()}`
          const remote = yield* upstream(secret)
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.decision, 'Allowed')
          const vivid = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          const person = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('live-integration'),
          })
          const registered = yield* Ref.make<Option.Option<ConnectionId>>(Option.none())
          const address = ConnectionAddress.of({
            inspect: Effect.fn('IntegrationLive.source')(() =>
              Effect.succeed(
                kind === 'Mcp'
                  ? ConnectionSource.cases.Mcp.make({
                      address: `${remote.address}/mcp`,
                      authorization: 'apiKey',
                    })
                  : ConnectionSource.cases.OpenApi.make({
                      address: `${remote.address}/spec`,
                    }),
              ),
            ),
          })
          yield* Effect.gen(function* () {
            const store = yield* ConnectionStore
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const id = yield* Ref.get(registered)
                if (Option.isSome(id)) {
                  const removed = yield* Effect.exit(store.remove(ownerActor, id.value))
                  expect(removed._tag).toBe('Success')
                }
              }),
            )
            const result = yield* connectionHandlers
              .AddIntegration({
                address: `https://integration.example/${kind}`,
                name: 'Live Fixture',
                shared: false,
              })
              .pipe(
                Effect.provideService(AuthContext, vivid),
                Effect.provideService(ConnectionAddress, address),
              )
            if (AddIntegrationOutcome.guards.NeedsKey(result)) {
              yield* Ref.set(registered, Option.some(result.step.connection.id))
              expect(result.step.fields).toEqual([{ name: 'token', label: 'token' }])
              yield* connectionHandlers
                .CompleteConnection({
                  id: result.step.connection.id,
                  fields: { token: Redacted.make(secret) },
                })
                .pipe(Effect.provideService(AuthContext, person))
            } else {
              expect(result._tag).toBe('Added')
              const records = yield* store.records(ownerActor)
              const row = records.find((entry) => entry.label === 'Live Fixture')
              if (row === undefined) return yield* Effect.die('Registration did not persist')
              yield* Ref.set(registered, Option.some(row.id))
            }
            const found = yield* connectionHandlers
              .FindIntegrations({ query: 'Live Fixture' })
              .pipe(Effect.provideService(AuthContext, vivid))
            const tested = yield* connectionHandlers
              .TestIntegration({ account: 'Live Fixture' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(tested._tag).toBe('Tested')
            expect(yield* Ref.get(remote.called)).toBe(1)
            const database = yield* Database
            const audit = yield* database.run(
              database
                .select()
                .from(auditEntries)
                .where(eq(auditEntries.personId, ownerActor.person.id)),
            )
            const records = yield* store.records(ownerActor)
            expect(JSON.stringify({ result, found, tested, audit, records })).not.toContain(secret)
            expect(audit.length).toBeGreaterThan(0)
            return yield* Effect.void
          }).pipe(
            Effect.scoped,
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provide(auditLayer, { local: true }),
            Effect.provide(liveExecutor),
          )
        }).pipe(Effect.scoped, Effect.provide(connectionTestLayer)),
      { timeout: 120_000 },
    )
  }
})
