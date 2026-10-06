import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { AddIntegrationOutcome, ToolOutcome } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { connectionAddressLayer } from './address.ts'
import { executorLayer } from './executor.ts'
import { connectionHandlers } from './handlers.ts'
import { ConnectionStore, ToolDiscovery, connectionStoreLayer } from './store.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { auditLayer } from '../audit/record.ts'
import { trustTestLayer } from '../approvals/testing.ts'
import { Database } from '../database/client.ts'
import { threads } from '../threads/tables.ts'

const executorUrl = NodeProcess.env['VIVID_TEST_EXECUTOR_URL']
const executorKey = NodeProcess.env['VIVID_TEST_EXECUTOR_KEY']
const enabled =
  NodeProcess.env['VIVID_LIVE_PUBLIC_INTEGRATIONS'] === '1' &&
  executorUrl !== undefined &&
  executorKey !== undefined &&
  NodeProcess.env['VIVID_TEST_DATABASE_URL'] !== undefined

const liveExecutor = executorLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GOOGLE_CLIENT_ID: 'isolated-test-client',
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: executorUrl,
        VIVID_EXECUTOR_KEY: executorKey,
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

const sources: readonly {
  name: string
  address: string
  query: string
  tool: string
  input: Schema.Json
}[] = [
  {
    name: 'Public Exa',
    address: 'https://mcp.exa.ai/mcp',
    query: 'web_search_exa',
    tool: 'queries.web_search_exa',
    input: {
      query: 'Effect TypeScript official documentation',
      objective:
        'Find the official Effect documentation home page, excluding third-party tutorials.',
      numResults: 1,
    },
  },
  // An OpenAPI document that asks for no sign-in. Swagger's Petstore was here and could never
  // pass: it signs in with OAuth's implicit flow, and Executor's OpenAPI import only knows the
  // authorization-code flow, so Vivid rightly answers that it cannot add it.
  {
    name: 'Public APIs.guru',
    address: 'https://api.apis.guru/v2/openapi.yaml',
    query: 'getMetrics',
    tool: 'queries.getMetrics',
    input: {},
  },
]

/** Real public inspection, SQL registration, discovery and use_tool dispatch run as a disposable
 * acting Person in a private Thread. Production Gate permits ordinary reads without consulting
 * the model judge. No address, Executor response, Gate decision or provider call is faked.
 */
describe.skipIf(!enabled)('Public integrations through Vivid and Executor', () => {
  for (const source of sources) {
    it.live(
      `adds ${source.name} by address, lists its tools and uses one public read`,
      () =>
        Effect.gen(function* () {
          const { personalActor, threadId } = yield* fixture()
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ companyId: null, audience: 'private' })
              .where(eq(threads.id, threadId)),
          )
          const auth = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          return yield* Effect.gen(function* () {
            const store = yield* ConnectionStore
            // Cleanup is installed before registration, including failures after a saved card.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const removed = yield* Effect.exit(
                  Effect.gen(function* () {
                    const rows = yield* store.records(personalActor)
                    for (const row of rows) yield* store.remove(personalActor, row.id)
                  }),
                )
                expect(removed._tag).toBe('Success')
              }),
            )
            const added = yield* connectionHandlers.AddIntegration({
              name: source.name,
              address: source.address,
              shared: false,
            })
            console.info(JSON.stringify({ source: source.name, added }))
            expect(AddIntegrationOutcome.guards.Added(added)).toBe(true)
            const rows = yield* store.records(personalActor)
            const row = rows.find((entry) => entry.name === source.name)
            if (row === undefined) return yield* Effect.die('Public registration did not persist')
            const discovery = yield* store.tools(personalActor, row)
            const tools = ToolDiscovery.match(discovery, {
              Ready: ({ tools: catalog }) => catalog,
              Failed: () => [],
            })
            console.info(
              JSON.stringify({ source: source.name, tools: tools.map((tool) => tool.name) }),
            )
            const discovered = yield* connectionHandlers.FindTools({ query: source.query })
            const selected = discovered.tools.find((tool) => tool.name === source.tool)
            expect(selected).toBeDefined()
            const resolved = yield* connectionHandlers.ResolveTool({
              account: source.name,
              tool: source.tool,
            })
            expect(resolved.effect).toBe('read')
            const used = yield* connectionHandlers.UseTool({
              connectionId: resolved.connectionId,
              tool: resolved.name,
              input: source.input,
              summary: 'Read public sample information',
              rationale: 'Verify that a public integration can be connected and used by address.',
            })
            console.info(
              JSON.stringify({
                source: source.name,
                outcome: used._tag,
                outputExcerpt: ToolOutcome.guards.Completed(used)
                  ? JSON.stringify(used.output).slice(0, 180)
                  : used,
              }),
            )
            expect(ToolOutcome.guards.Completed(used)).toBe(true)
            return yield* Effect.void
          }).pipe(
            Effect.scoped,
            Effect.provideService(AuthContext, auth),
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provide(auditLayer, { local: true }),
            Effect.provide(trustTestLayer, { local: true }),
            Effect.provide(connectionAddressLayer),
            Effect.provide(liveExecutor),
          )
        }).pipe(Effect.scoped, Effect.provide(connectionTestLayer)),
      { timeout: 120_000 },
    )
  }
})
