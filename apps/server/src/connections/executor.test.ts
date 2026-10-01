import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Redacted from 'effect/Redacted'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import {
  Executor,
  ExecutorAppId,
  ExecutorCallOutcome,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorRequestId,
  ExecutorStep,
  executorLayer,
} from './executor.ts'

const url = NodeProcess.env['VIVID_TEST_EXECUTOR_URL']
const key = NodeProcess.env['VIVID_TEST_EXECUTOR_KEY']
const publicService = ServiceId.make('curated/deepwiki-com-mcp')
const liveLayer = executorLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        VIVID_EXECUTOR_URL: url,
        VIVID_EXECUTOR_KEY: key,
      }),
    ),
  ),
)

/** Missing configuration disables the entire authority seam, including mutations and resume. */
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
          executor.complete({ references, fields: {} }),
          executor.completeSignIn({
            references,
            callbackAddress: Redacted.make('https://vivid.example.test/callback'),
          }),
          executor.status(references),
          executor.remove(references),
          executor.tools(references),
          executor.call({ references, tool: 'unconfigured', input: {} }),
          executor.resume({
            references,
            requestId: ExecutorRequestId.make('unconfigured-request'),
            accept: true,
          }),
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

/** The isolated local server and public upstream are opt-in; the HTTP adapter itself is never mocked. */
describe.skipIf(url === undefined || key === undefined)('Executor live HTTP', () => {
  it.effect('lists a non-empty authorized catalog', () =>
    Effect.gen(function* () {
      const executor = yield* Executor
      const entries = yield* executor.catalog()
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((entry) => entry.id === publicService)).toBe(true)
    }).pipe(Effect.provide(liveLayer)),
  )

  it.effect(
    'imports a public service, discovers its exact tool name, and completes a real read',
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor
        yield* Effect.acquireUseRelease(
          executor.begin({
            connectionId: ConnectionId.make(crypto.randomUUID()),
            service: publicService,
            owner: ExecutorOwnerId.make('vivid-executor-test'),
            subject: 'vivid-executor-test-person',
            label: 'Test',
            returnAddress: 'https://vivid.example.test/connections/callback',
          }),
          Effect.fn('ExecutorTest.read')(function* (step) {
            expect(ExecutorStep.guards.Done(step)).toBe(true)
            const status = yield* executor.status(step.references)
            expect(status._tag).toBe('Ready')
            const tools = yield* executor.tools(step.references)
            const tool = tools.find(
              (candidate) => candidate.name === 'mutations.read_wiki_structure',
            )
            expect(tool).toBeDefined()
            if (tool === undefined) {
              expect.fail('The public service did not expose its documented tool')
            }
            const rejected = yield* executor.call({
              references: step.references,
              tool: tool.name,
              input: {},
            })
            expect(ExecutorCallOutcome.guards.Rejected(rejected)).toBe(true)
            const result = yield* executor.call({
              references: step.references,
              tool: tool.name,
              input: { repoName: 'facebook/react' },
            })
            expect(ExecutorCallOutcome.guards.Completed(result)).toBe(true)
            if (ExecutorCallOutcome.guards.Completed(result))
              expect(JSON.stringify(result.value)).toContain('React')
          }),
          Effect.fn('ExecutorTest.cleanup')(function* (step) {
            const removed = yield* executor.remove(step.references).pipe(Effect.result)
            expect(Result.isSuccess(removed)).toBe(true)
          }),
        )
      }).pipe(Effect.provide(liveLayer)),
    { timeout: 120_000 },
  )
})
