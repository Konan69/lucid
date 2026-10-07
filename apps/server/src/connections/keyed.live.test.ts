import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { AddIntegrationOutcome, ConnectionId, ConnectionState, SessionId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Logger, Option, Redacted, Ref } from 'effect'
import { eq } from 'drizzle-orm'
import { executorLayer } from './executor.ts'
import { connectionAddressLayer } from './address.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionHandlers } from './handlers.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { Database } from '../database/client.ts'

const enabled =
  NodeProcess.env['VIVID_LIVE_GITHUB'] === '1' &&
  NodeProcess.env['VIVID_TEST_DATABASE_URL'] !== undefined
const configured = executorLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GOOGLE_CLIENT_ID: 'isolated-test-client',
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

/** Real RPC handlers, SQL and beta.8 adapter prove that the key card completes without moving
 * credentials into product records, audit or model views. Only Gate/model judgement is supplied
 * by the existing test Layer; the provider registration, discovery and call are real. */
describe.skipIf(!enabled)('keyed MCP product acceptance', () => {
  layer(connectionTestLayer, { excludeTestServices: true })((it) => {
    it.effect(
      'adds GitHub, completes the key card, discovers tools and isolates a second Person',
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor, memberActor, threadId } = yield* fixture()
          const vivid = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          const person = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('keyed-proof'),
          })
          const other = AuthState.Vivid({
            person: memberActor.person,
            workspace: memberActor.workspace,
            threadId,
          })
          const registered = yield* Ref.make<Option.Option<ConnectionId>>(Option.none())
          yield* Effect.gen(function* () {
            // This composed fixture owns per-case state and resources; build it in the test scope.
            const context = yield* Layer.build(connectionAddressLayer)
            return yield* Effect.gen(function* () {
              // This composed fixture owns per-case state and resources; build it in the test scope.
              const context = yield* Layer.build(configured)
              return yield* Effect.gen(function* () {
                // Preserve local provision: rebuild against this case's overridden authorities.
                const context = yield* Layer.build(Layer.fresh(auditLayer))
                return yield* Effect.gen(function* () {
                  // Preserve local provision: rebuild against this case's overridden authorities.
                  const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
                  return yield* Effect.gen(function* () {
                    const store = yield* ConnectionStore
                    yield* Effect.addFinalizer(() =>
                      Effect.gen(function* () {
                        const id = yield* Ref.get(registered)
                        if (Option.isSome(id)) {
                          const cleanup = yield* store
                            .remove(ownerActor, id.value)
                            .pipe(Effect.exit)
                          expect(cleanup._tag).toBe('Success')
                        }
                      }),
                    )
                    const result = yield* connectionHandlers
                      .AddIntegration({
                        address: 'https://api.githubcopilot.com/mcp/',
                        name: 'GitHub proof',
                        shared: false,
                      })
                      .pipe(Effect.provideService(AuthContext, vivid))
                    if (!AddIntegrationOutcome.guards.NeedsKey(result))
                      return expect.fail(`Expected NeedsKey, received ${result._tag}`)
                    yield* Ref.set(registered, Option.some(result.step.connection.id))
                    expect(result.step.fields).toEqual([
                      { name: 'token', label: 'Personal access token' },
                    ])
                    const token = NodeProcess.env['VIVID_TEST_GITHUB_TOKEN']
                    if (token === undefined) return expect.fail('Supply test token authority')
                    const completed = yield* connectionHandlers
                      .CompleteConnection({
                        id: result.step.connection.id,
                        fields: { token: Redacted.make(token) },
                      })
                      .pipe(Effect.provideService(AuthContext, person))
                    expect(ConnectionState.guards.Ready(completed.connection.state)).toBe(true)
                    const found = yield* connectionHandlers
                      .FindTools({ query: 'GitHub', limit: 100 })
                      .pipe(Effect.provideService(AuthContext, vivid))
                    expect(found.tools.length).toBeGreaterThan(0)
                    const hidden = yield* connectionHandlers
                      .FindTools({ query: 'GitHub', limit: 100 })
                      .pipe(Effect.provideService(AuthContext, other))
                    expect(hidden.tools).toHaveLength(0)
                    expect(yield* store.records(memberActor)).toHaveLength(0)
                    const refused = yield* connectionHandlers
                      .UseTool({
                        connectionId: result.step.connection.id,
                        tool: 'get_me',
                        input: {},
                        summary: 'Read account',
                        rationale: 'Verify account access',
                      })
                      .pipe(Effect.provideService(AuthContext, other))
                    expect(refused._tag).toBe('Rejected')
                    const records = yield* store.records(ownerActor)
                    const database = yield* Database
                    const audit = yield* database.run(
                      database
                        .select()
                        .from(auditEntries)
                        .where(eq(auditEntries.personId, ownerActor.person.id)),
                    )
                    expect(audit.length).toBeGreaterThan(0)
                    expect(
                      JSON.stringify({ result, completed, found, records, audit }).includes(token),
                    ).toBe(false)
                    NodeProcess.stdout.write(
                      `keyed product tools=${found.tools.length} second-person-tools=${hidden.tools.length}\n`,
                    )
                    return yield* Effect.void
                  }).pipe(Effect.scoped, Effect.provide(context))
                }).pipe(Effect.scoped, Effect.provide(context))
              }).pipe(Effect.scoped, Effect.provide(context))
            }).pipe(Effect.scoped, Effect.provide(context))
          }).pipe(Effect.scoped)
        }).pipe(Effect.scoped, Effect.provideService(Logger.CurrentLoggers, new Set([]))),
      { timeout: 120_000 },
    )
  })
})
