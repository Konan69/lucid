import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import {
  Executor,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  executorLayer,
} from './executor.ts'

const publicService = ServiceId.make('curated/deepwiki-com-mcp')

/** Missing configuration disables the entire authority seam, including every mutation. */
describe('Executor installation', () => {
  for (const configuration of [
    { name: 'both values missing', values: {} },
    { name: 'key missing', values: { VIVID_EXECUTOR_URL: 'https://vivid.example.test' } },
    {
      name: 'URL missing',
      values: { VIVID_EXECUTOR_KEY: 'isolated-test-configuration-placeholder' },
    },
  ]) {
    const missingLayer = executorLayer.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration.values))),
    )
    it.effect(`fails every operation with ServiceUnavailable: ${configuration.name}`, () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const references = ExecutorReferences.cases.Public.make({
          service: publicService,
          owner: ExecutorOwnerId.make('unconfigured'),
          app: ExecutorAppId.make('unconfigured-app'),
          profile: ExecutorProfileId.make('unconfigured-profile'),
        })
        const operations = [
          executor.catalog(),
          executor.authorization({
            service: publicService,
            returnAddress: 'https://vivid.example.test/',
          }),
          executor.begin({
            connectionId: ConnectionId.make(crypto.randomUUID()),
            service: publicService,
            owner: references.owner,
            subject: 'unconfigured-person',
            label: 'Test',
            returnAddress: 'https://vivid.example.test/connections/callback',
          }),
          executor.reauthorize({
            references,
            connectionId: ConnectionId.make('unconfigured-resume'),
            service: publicService,
            owner: references.owner,
            subject: 'unconfigured-person',
            label: 'Resume',
            returnAddress: 'https://vivid.example.test/return',
          }),
          executor.complete({ references, fields: {} }),
          executor.completeSignIn({
            references,
            callbackAddress: Redacted.make('https://vivid.example.test/callback'),
          }),
          executor.status(references),
          executor.remove(references),
          executor.tools(references),
          executor.call({ references, tool: 'unconfigured', input: {} }),
        ]
        for (const operation of operations) {
          const error = yield* operation.pipe(Effect.flip)
          expect(error).toBeInstanceOf(ServiceUnavailable)
          expect(error).toMatchObject({ service: 'connections' })
        }
      }).pipe(Effect.provide(missingLayer)),
    )
  }
})
