import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import { hostedExecutorFixture, hostedPrefix, hostedService } from './testing.ts'
import { DecisionModel } from 'effect/unstable/ai'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import {
  Executor,
  ExecutorAppId,
  ExecutorAuthorizationId,
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

/** The real inspect payload erases provenance before this HTTP adapter sees it.
 * These two entries represent explicit false and absent upstream hints after host
 * projection; both must retain the same current classification behaviour. This
 * test records the limit, rather than inventing a declaration from a false value. */
it.effect('cannot distinguish declared writes from host-defaulted writes', () =>
  Effect.gen(function* () {
    const hosted = yield* hostedExecutorFixture()
    yield* Ref.update(hosted.replies, (replies) =>
      new Map(replies).set(`GET ${hostedPrefix}/apps/app/tools`, {
        status: 200,
        body: {
          profile: 'profile',
          deployment: 'deployment',
          profileRevision: 1,
          items: ['declared_write', 'undeclared'].map((name) => ({
            name,
            description: 'Retrieve the existing record',
            inputSchema: {},
            readOnly: false,
            annotations: { readOnlyHint: false },
          })),
        },
      }),
    )
    const references = ExecutorReferences.cases.Public.make({
      service: hostedService,
      app: ExecutorAppId.make('app'),
      profile: ExecutorProfileId.make('profile'),
      owner: ExecutorOwnerId.make('owner'),
    })
    const tools = yield* Effect.flatMap(Executor, (executor) => executor.tools(references)).pipe(
      Effect.provide(hosted.configured),
    )
    expect(tools.map((tool) => tool.effect)).toEqual(['write', 'write'])
    const judged = yield* Effect.gen(function* () {
      return yield* (yield* ToolEffects).classifyBatch({
        serviceId: hostedService,
        service: 'Records',
        tools,
      })
    }).pipe(
      Effect.provide(
        toolEffectsLayer.pipe(
          Layer.provide(
            Layer.effect(
              DecisionModel.DecisionModel,
              DecisionModel.make({
                decide: ({ decisions }) =>
                  Effect.succeed({
                    answers: Object.fromEntries(
                      Object.keys(decisions).map((key) => [
                        key,
                        ScriptedAnswer.cases.Classify.make({
                          label: 'read',
                          probabilities: { read: 0.96, write: 0.04, destructive: 0 },
                        }),
                      ]),
                    ),
                    usage: { inputTokens: undefined, outputTokens: undefined },
                  }),
              }),
            ),
          ),
        ),
      ),
    )
    expect(judged.map((tool) => tool.effect)).toEqual(['read', 'read'])
  }),
)

/** Executor may echo rejected secrets in its HTTP payload. Completion exposes only the fixed
 * domain refusal, never that payload or the encoded key in an Error message or public fields. */
it.effect('does not echo a token when credential submission fails', () =>
  Effect.gen(function* () {
    const hosted = yield* hostedExecutorFixture()
    const token = 'synthetic-token-that-must-stay-private'
    yield* Ref.update(hosted.replies, (replies) =>
      new Map(replies).set(`POST ${hostedPrefix}/connections/authorization/submit`, {
        status: 422,
        body: Schema.TaggedStruct('AccountFieldsInvalid', {
          message: Schema.String,
          supplied: Schema.String,
        }).make({ message: token, supplied: token }),
      }),
    )
    const references = ExecutorReferences.cases.EnteringKey.make({
      service: hostedService,
      app: ExecutorAppId.make('app'),
      profile: ExecutorProfileId.make('profile'),
      owner: ExecutorOwnerId.make('owner'),
      authorization: ExecutorAuthorizationId.make('authorization'),
      method: 'pat',
      label: 'Private',
    })
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Executor).complete({
        references,
        fields: { token: Redacted.make(token) },
      })
    }).pipe(Effect.provide(hosted.configured), Effect.flip)
    expect(error._tag).toBe('ExecutorRejected')
    expect(error.message).not.toContain(token)
    expect(JSON.stringify(error)).not.toContain(token)
  }),
)
