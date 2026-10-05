import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Logger, Redacted } from 'effect'
import { ConnectionAddress, connectionAddressLayer } from './address.ts'
import { Executor, ExecutorOwnerId, ExecutorStep, executorLayer } from './executor.ts'

const enabled = NodeProcess.env['VIVID_LIVE_GITHUB'] === '1'
const configured = executorLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

/** Acceptance proof against the deployed image, not the newer checkout's import contract.
 * Executor packages/catalog/src/contracts/imports.ts now declares ImportAuth, but beta.8
 * ignores it. These tests stay opt-in and must pass before claiming a Person can connect
 * GitHub with their own token. Only the credential submission receives the redacted token.
 */
describe.skipIf(!enabled)('GitHub personal credential acceptance', () => {
  for (const entry of ['catalogue', 'address']) {
    it.live(
      `connects by ${entry} with a personal token and discovers tools`,
      () =>
        Effect.gen(function* () {
          const executor = yield* Executor
          const input = {
            connectionId: ConnectionId.make(crypto.randomUUID()),
            service: ServiceId.make(
              entry === 'catalogue' ? 'curated/github-com-mcp' : 'github-personal-proof',
            ),
            owner: ExecutorOwnerId.make('github-personal-proof'),
            subject: 'github-personal-proof',
            label: 'GitHub personal proof',
            returnAddress: 'https://vivid.example.test/api/connections/return',
          }
          const step = yield* entry === 'catalogue'
            ? executor.begin(input)
            : Effect.gen(function* () {
                const reader = yield* ConnectionAddress
                const source = yield* reader.inspect('https://api.githubcopilot.com/mcp/')
                return yield* executor.add({ ...input, source })
              })
          // Register cleanup before assertions or token submission can fail.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const removed = yield* executor.remove(step.references).pipe(Effect.exit)
              expect(removed._tag).toBe('Success')
            }),
          )
          expect(ExecutorStep.guards.EnterKey(step)).toBe(true)
          if (!ExecutorStep.guards.EnterKey(step))
            return expect.fail('GitHub must offer personal token entry')
          const token = NodeProcess.env['VIVID_TEST_GITHUB_TOKEN']
          if (token === undefined) return expect.fail('Supply the personal token in test authority')
          const references = yield* executor.complete({
            references: step.references,
            fields: { token: Redacted.make(token) },
          })
          const tools = yield* executor.tools(references)
          expect(tools.length).toBeGreaterThan(0)
          NodeProcess.stdout.write(`GitHub ${entry} tools=${tools.length}\n`)
          return yield* Effect.void
        }).pipe(
          Effect.scoped,
          Effect.provide(configured),
          Effect.provide(Logger.layer([])),
          Effect.provide(connectionAddressLayer),
        ),
      { timeout: 120_000 },
    )
  }
})

/** Public MCP remains on URL import and returns Done without a credential card. */
describe.skipIf(!enabled)('public MCP regression', () => {
  it.live(
    'adds DeepWiki without requesting a key',
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const source = yield* (yield* ConnectionAddress).inspect('https://mcp.deepwiki.com/mcp')
        const step = yield* executor.add({
          connectionId: ConnectionId.make(crypto.randomUUID()),
          service: ServiceId.make('deepwiki-proof'),
          owner: ExecutorOwnerId.make('deepwiki-proof'),
          subject: 'deepwiki-proof',
          label: 'DeepWiki',
          returnAddress: 'https://vivid.example.test/api/connections/return',
          source,
        })
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const cleanup = yield* executor.remove(step.references).pipe(Effect.exit)
            expect(cleanup._tag).toBe('Success')
          }),
        )
        expect(ExecutorStep.guards.Done(step)).toBe(true)
        const tools = yield* executor.tools(step.references)
        expect(tools.length).toBeGreaterThan(0)
        NodeProcess.stdout.write(`public tools=${tools.length}\n`)
      }).pipe(
        Effect.scoped,
        Effect.provide(configured),
        Effect.provide(Logger.layer([])),
        Effect.provide(connectionAddressLayer),
      ),
    { timeout: 120_000 },
  )
})
