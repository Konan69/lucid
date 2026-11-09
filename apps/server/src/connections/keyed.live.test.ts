import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  AddIntegrationOutcome,
  ConnectionState,
  SessionId,
  ToolOutcome,
  ToolCallId,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Logger, Redacted, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { executorLayer } from './executor.ts'
import { connectionAddressLayer } from './address.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionHandlers } from './handlers.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { connections } from './tables.ts'
import { Database } from '../database/client.ts'

const decodeContent = Schema.decodeUnknownEffect(
  Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
  }),
)
const decodeAccount = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String, id: Schema.Int })),
)

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
        VIVID_EXECUTOR_PUBLIC_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

/** Real RPC handlers, SQL and Executor adapter prove that the key card completes without moving
 * credentials into product records, audit or model views. Only Gate/model judgement is supplied
 * by the existing test Layer; the provider registration, discovery and call are real. */
describe.skipIf(!enabled)('keyed MCP product acceptance', () => {
  layer(
    auditLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(configured, connectionAddressLayer).pipe(
          Layer.provideMerge(connectionTestLayer),
        ),
      ),
    ),
    { excludeTestServices: true, timeout: 120_000 },
  )((it) => {
    it.effect(
      'adds GitHub, completes the key card, discovers tools and isolates a second Person',
      () =>
        Effect.gen(function* () {
          const token = NodeProcess.env['VIVID_TEST_GITHUB_TOKEN']
          const expectedLogin = NodeProcess.env['VIVID_TEST_GITHUB_LOGIN']
          const expectedId = NodeProcess.env['VIVID_TEST_GITHUB_ACCOUNT_ID']
          if (
            token === undefined ||
            expectedLogin === undefined ||
            expectedId === undefined ||
            !/^\d+$/u.test(expectedId)
          )
            expect.fail(
              'Supply token authority and independently known GitHub login and numeric account id',
            )

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
          yield* Effect.gen(function* () {
            // Rebuild the store under the harness's live Executor and persisted audit authorities.
            const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
            return yield* Effect.gen(function* () {
              const store = yield* ConnectionStore
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  // Remove any saved card for this UUID-owned Person, even when Add lost its reply.
                  const rows = yield* store.records(ownerActor)
                  for (const row of rows) {
                    const cleanup = yield* store.remove(ownerActor, row.id).pipe(Effect.exit)
                    expect(cleanup._tag).toBe('Success')
                  }
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => expect.fail(`Cleanup failed: ${error._tag}`)),
                  ),
                ),
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
              expect(result.step.fields).toEqual([
                { name: 'token', label: 'Personal access token' },
              ])
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
              const accountTool = found.tools.find((candidate) =>
                /(?:^|\.)get_me$/u.test(candidate.name),
              )
              if (accountTool === undefined) expect.fail('Expected an authenticated account read')
              const { outcome: read } = yield* connectionHandlers
                .UseTool({
                  toolCallId: ToolCallId.make(crypto.randomUUID()),
                  connectionId: result.step.connection.id,
                  tool: accountTool.name,
                  input: {},
                  summary: 'Read authenticated account',
                  rationale: 'Verify the connected account',
                })
                .pipe(Effect.provideService(AuthContext, vivid))
              if (!ToolOutcome.guards.Completed(read))
                expect.fail('Authenticated read did not complete')
              const response = yield* decodeContent(read.output)
              const [text] = response.content
              if (text === undefined) expect.fail('Expected account response text')
              const account = yield* decodeAccount(text.text)
              expect(account).toEqual({ login: expectedLogin, id: Number(expectedId) })
              const hidden = yield* connectionHandlers
                .FindTools({ query: 'GitHub', limit: 100 })
                .pipe(Effect.provideService(AuthContext, other))
              expect(hidden.tools).toHaveLength(0)
              expect(yield* store.records(memberActor)).toHaveLength(0)
              const { outcome: refused } = yield* connectionHandlers
                .UseTool({
                  toolCallId: ToolCallId.make(crypto.randomUUID()),
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
              const raw = yield* database.run(
                database
                  .select()
                  .from(connections)
                  .where(eq(connections.id, result.step.connection.id)),
              )
              expect(JSON.stringify(raw).includes(token)).toBe(false)
              expect(audit.length).toBeGreaterThan(0)
              expect(
                JSON.stringify({ result, completed, found, records, audit }).includes(token),
              ).toBe(false)
              NodeProcess.stdout.write(
                `keyed product tools=${found.tools.length} second-person-tools=${hidden.tools.length}\n`,
              )
              return yield* Effect.void
            }).pipe(Effect.scoped, Effect.provide(context))
          }).pipe(Effect.scoped, Effect.scoped, Effect.scoped, Effect.scoped)
        }).pipe(Effect.scoped, Effect.provideService(Logger.CurrentLoggers, new Set([]))),
      { timeout: 120_000 },
    )
  })
})
