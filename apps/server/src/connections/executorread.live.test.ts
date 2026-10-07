import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Logger, Redacted, Ref } from 'effect'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorStep,
  ExecutorCallOutcome,
  executorLayer,
} from './executor.ts'

const enabled = NodeProcess.env['VIVID_LIVE_GITHUB'] === '1'
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

/** Acceptance proof against the deployed image, not the newer checkout's import contract.
 * Executor packages/catalog/src/contracts/imports.ts now declares ImportAuth, but beta.8
 * ignores it. These tests stay opt-in and must pass before claiming a Person can connect
 * GitHub with their own token. Only the credential submission receives the redacted token.
 */
describe.skipIf(!enabled)('GitHub authenticated read acceptance', () => {
  layer(configured, { excludeTestServices: true })((it) => {
    it.effect(
      'reads the authenticated GitHub account with a personal token',
      () =>
        Effect.gen(function* () {
          const executor = yield* Executor
          const input = {
            connectionId: ConnectionId.make(crypto.randomUUID()),
            service: ServiceId.make('curated/github-com-mcp'),
            owner: ExecutorOwnerId.make('github-personal-proof'),
            subject: 'github-personal-proof',
            label: 'GitHub personal proof',
            returnAddress: 'https://vivid.example.test/api/connections/return',
          }
          const step = yield* executor.begin(input)
          const removed = yield* Ref.make(false)
          // Register cleanup before assertions or token submission can fail.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (yield* Ref.get(removed)) return
              const cleanup = yield* executor.remove(step.references).pipe(Effect.exit)
              expect(cleanup._tag).toBe('Success')
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
          const tool = tools.find((candidate) => /(?:^|\.)get_me$/u.test(candidate.name))
          if (tool === undefined)
            return expect.fail('GitHub must expose its authenticated account read')
          const outcome = yield* executor.call({ references, tool: tool.name, input: {} })
          expect(ExecutorCallOutcome.guards.Completed(outcome)).toBe(true)
          yield* executor.remove(references)
          yield* Ref.set(removed, true)
          const unavailable = yield* executor.tools(references).pipe(Effect.flip)
          // beta.8 masks a deleted app as organization access denial, before its tool route.
          expect(unavailable._tag).toBe('ExecutorAccessDenied')
          NodeProcess.stdout.write(`GitHub read tools=${tools.length} reads=1 removed-app=1\n`)
          return yield* Effect.void
        }).pipe(Effect.scoped, Effect.provideService(Logger.CurrentLoggers, new Set([]))),
      { timeout: 120_000 },
    )
  })
})
