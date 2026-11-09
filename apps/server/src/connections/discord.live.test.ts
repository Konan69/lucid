import * as NodeProcess from 'node:process'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { discordFiles, discordServiceId } from './discord.ts'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorStep,
  executorLayer,
  installationCaller,
} from './executor.ts'

const liveLayer = executorLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GOOGLE_CLIENT_ID: 'isolated-test-client',
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_PUBLIC_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
      }),
    ),
  ),
)

describe.skipIf(NodeProcess.env['VIVID_LIVE_DISCORD'] !== '1')('Discord on Executor', () => {
  layer(liveLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
    it.effect(
      'deploys, binds a dummy credential and lists exactly three reads and three writes',
      () =>
        Effect.gen(function* () {
          const executor = yield* Executor
          yield* Effect.acquireUseRelease(
            executor.as(installationCaller).begin({
              connectionId: ConnectionId.make(crypto.randomUUID()),
              service: discordServiceId,
              owner: ExecutorOwnerId.make(`discord-proof-${crypto.randomUUID()}`),
              subject: 'discord-proof-person',
              label: 'Discord verification',
              returnAddress: 'https://vivid.example.test/api/connections/return',
            }),
            (step) =>
              Effect.gen(function* () {
                if (!ExecutorStep.guards.EnterKey(step)) expect.fail('Discord requires a token')
                const token = 'disposable-discord-token'
                const references = yield* executor.as(installationCaller).complete({
                  references: step.references,
                  fields: { token: Redacted.make(token) },
                })
                expect(JSON.stringify(discordFiles())).not.toContain(token)
                const tools = yield* executor.as(installationCaller).tools(references)
                expect(
                  tools
                    .map(({ name, effect }) => ({ name, effect }))
                    .toSorted((a, b) => a.name.localeCompare(b.name)),
                ).toEqual([
                  { name: 'channels.createMessage', effect: 'write' },
                  { name: 'channels.createThreadFromMessage', effect: 'write' },
                  { name: 'channels.editMessage', effect: 'write' },
                  { name: 'channels.listMessages', effect: 'read' },
                  { name: 'guilds.listGuildChannels', effect: 'read' },
                  { name: 'users.listMyGuilds', effect: 'read' },
                ])
              }),
            (step) => executor.as(installationCaller).remove(step.references),
          )
        }),
      { timeout: 240_000 },
    )
  })
})
