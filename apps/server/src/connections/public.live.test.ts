import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { AddIntegrationOutcome, ToolOutcome, ToolCallId } from '@vivid/contracts'
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

const decodeRead = Schema.decodeUnknownEffect(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ type: Schema.Literal('text'), text: Schema.NonEmptyString }),
    ).check(Schema.isMinLength(1)),
  }),
)

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
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
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
    name: 'Public Documentation',
    address: 'https://developers.openai.com/mcp',
    query: 'fetch_openai_doc',
    tool: 'fetch_openai_doc',
    input: { url: 'https://developers.openai.com/codex/cli' },
  },
]

/** The public documentation server declares fetch_openai_doc readOnlyHint=true in tools/list
 * at https://developers.openai.com/mcp. Verify the requested page's heading and getting-started
 * section as well as its completed envelope: a provider quota/error message is not a read.
 * Real public inspection, SQL registration, discovery and use_tool dispatch run as a disposable
 * acting Person in a private Thread. Production Gate permits ordinary reads without consulting
 * the model judge. No address, Executor response, Gate decision or provider call is faked.
 */
describe.skipIf(!enabled)('Public integrations through Vivid and Executor', () => {
  for (const source of sources) {
    layer(
      auditLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(liveExecutor, connectionAddressLayer, trustTestLayer).pipe(
            Layer.provideMerge(connectionTestLayer),
          ),
        ),
      ),
      { excludeTestServices: true, timeout: 120_000 },
    )((it) => {
      it.effect(
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
              // Capture the live public adapter, production audit and approval gate for this source.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
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
                  another: false,
                  shared: false,
                })
                console.info(JSON.stringify({ source: source.name, added }))
                expect(AddIntegrationOutcome.guards.Added(added)).toBe(true)
                const rows = yield* store.records(personalActor)
                const row = rows.find((entry) => entry.service === `url:${source.address}`)
                if (row === undefined)
                  return yield* Effect.die('Public registration did not persist')
                const discovery = yield* store.tools(personalActor, row)
                const tools = ToolDiscovery.match(discovery, {
                  Ready: ({ tools: catalog }) => catalog,
                  NeedsAuthorization: () => [],
                  Failed: () => [],
                })
                console.info(
                  JSON.stringify({
                    source: source.name,
                    tools: tools.map((tool) => tool.name),
                  }),
                )
                const discovered = yield* connectionHandlers.FindTools({
                  query: source.query,
                })
                const selected = discovered.tools.find((tool) => tool.name === source.tool)
                expect(selected).toBeDefined()
                const resolved = yield* connectionHandlers.ResolveTool({
                  account: source.name,
                  tool: source.tool,
                })
                expect(resolved.effect).toBe('read')
                const { outcome: used } = yield* connectionHandlers.UseTool({
                  toolCallId: ToolCallId.make(crypto.randomUUID()),
                  connectionId: resolved.connectionId,
                  tool: resolved.name,
                  input: source.input,
                  summary: 'Read public sample information',
                  rationale:
                    'Verify that a public integration can be connected and used by address.',
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
                if (!ToolOutcome.guards.Completed(used)) expect.fail('Public read did not complete')
                const response = yield* decodeRead(used.output)
                const text = response.content.map((part) => part.text).join('\n')
                expect(text).toMatch(/^# Codex CLI$/mu)
                expect(text).toMatch(/^## Getting started$/mu)
                return yield* Effect.void
              }).pipe(
                Effect.scoped,
                Effect.provideService(AuthContext, auth),
                Effect.provide(context),
              )
            }).pipe(Effect.scoped, Effect.scoped, Effect.scoped, Effect.scoped, Effect.scoped)
          }).pipe(Effect.scoped),
        { timeout: 120_000 },
      )
    })
  }
})
