import { describe, expect, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import { hostedExecutorFixture, hostedPrefix, hostedService } from './testing.ts'
import { DecisionModel } from 'effect/ai'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { ConfigurationError } from '../config.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import {
  ExecutorAppOwnership,
  Executor,
  ExecutorAppId,
  ExecutorAuthorizationId,
  ExecutorOwnerId,
  ExecutorBinding,
  ExecutorReferences,
  executorLayer,
} from './executor.ts'

const settings = {
  GOOGLE_CLIENT_ID: 'isolated-test-client',
  GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
  VIVID_EXECUTOR_URL: 'https://executor.example.test',
  VIVID_EXECUTOR_KEY: 'isolated-test-key',
  VIVID_EXECUTOR_ORGANIZATION: 'isolated-test-organization',
}

/**
 * Integrations are part of every running Vivid: with any Executor setting missing or malformed the
 * Layer does not build, so the server does not start, and the failure names the variable without
 * carrying any supplied value.
 */
describe('Executor settings', () => {
  for (const [name, values, variable] of [
    [
      'the address is missing',
      { ...settings, VIVID_EXECUTOR_URL: undefined },
      'VIVID_EXECUTOR_URL',
    ],
    [
      'the address is not a URL',
      { ...settings, VIVID_EXECUTOR_URL: 'executor' },
      'VIVID_EXECUTOR_URL',
    ],
    ['the key is missing', { ...settings, VIVID_EXECUTOR_KEY: undefined }, 'VIVID_EXECUTOR_KEY'],
    ['the key is blank', { ...settings, VIVID_EXECUTOR_KEY: '' }, 'VIVID_EXECUTOR_KEY'],
    [
      'the organization is missing',
      { ...settings, VIVID_EXECUTOR_ORGANIZATION: undefined },
      'VIVID_EXECUTOR_ORGANIZATION',
    ],
    // Google Integrations sign in with the installation's Google client, so it is required here too.
    [
      'the Google client id is missing',
      { ...settings, GOOGLE_CLIENT_ID: undefined },
      'GOOGLE_CLIENT_ID',
    ],
    [
      'the Google client secret is blank',
      { ...settings, GOOGLE_CLIENT_SECRET: '' },
      'GOOGLE_CLIENT_SECRET',
    ],
  ] as const) {
    it.effect(`does not build when ${name}`, () =>
      Effect.gen(function* () {
        // Building the failing production layer is the assertion: acquisition must report the missing setting.
        const failure = yield* Layer.build(
          executorLayer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
          ),
        ).pipe(Effect.scoped, Effect.flip)
        expect(failure).toBeInstanceOf(ConfigurationError)
        expect(failure).toMatchObject({ variable })
        expect(JSON.stringify(failure)).not.toContain(settings.VIVID_EXECUTOR_KEY)
        expect(JSON.stringify(failure)).not.toContain(settings.GOOGLE_CLIENT_SECRET)
      }),
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
          version: 'version',
          accounts: { app: {} },
          routers: [],
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
      appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
      service: hostedService,
      app: ExecutorAppId.make('app'),
      binding: ExecutorBinding.cases.Public.make({}),
      owner: ExecutorOwnerId.make('owner'),
    })
    const tools = yield* Effect.gen(function* () {
      // This recorder controls the two indistinguishable upstream write declarations.
      const context = yield* Layer.build(hosted.configured)
      return yield* Effect.flatMap(Executor, (executor) => executor.tools(references)).pipe(
        Effect.provide(context),
      )
    }).pipe(Effect.scoped)
    expect(tools.map((tool) => tool.effect)).toEqual(['write', 'write'])
    const judged = yield* Effect.gen(function* () {
      // An empty classification cache judges this case's host-defaulted tool hints.
      const context = yield* Layer.build(
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
      )
      return yield* Effect.gen(function* () {
        return yield* (yield* ToolEffects).classifyBatch({
          serviceId: hostedService,
          service: 'Records',
          tools,
        })
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
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
      appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
      service: hostedService,
      app: ExecutorAppId.make('app'),
      binding: ExecutorBinding.cases.Public.make({}),
      owner: ExecutorOwnerId.make('owner'),

      authorization: ExecutorAuthorizationId.make('authorization'),
      method: 'pat',
      label: 'Private',
    })
    const error = yield* Effect.gen(function* () {
      // The credential recorder owns the rejected token submission and its redacted failure.
      const context = yield* Layer.build(hosted.configured)
      return yield* Effect.gen(function* () {
        return yield* (yield* Executor).complete({
          references,
          fields: { token: Redacted.make(token) },
        })
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped, Effect.flip)
    expect(error._tag).toBe('ExecutorRejected')
    expect(error.message).not.toContain(token)
    expect(JSON.stringify(error)).not.toContain(token)
  }),
)
