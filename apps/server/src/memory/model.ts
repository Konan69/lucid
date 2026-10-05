import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { optionalSetting } from '../config.ts'
import {
  modelGatewayKey,
  ProviderMalformed,
  providerResponse,
  type ProviderFailure,
} from './embeddings.js'

const ChatResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
      finish_reason: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
})
const decodeChat = HttpClientResponse.schemaBodyJson(ChatResponse)
export const Completion = Schema.TaggedUnion({
  Finished: { text: Schema.NonEmptyString },
  BudgetReached: { text: Schema.NonEmptyString },
})
export type Completion = typeof Completion.Type

export class MemoryGenerationIncomplete extends Schema.TaggedError<MemoryGenerationIncomplete>()(
  'MemoryGenerationIncomplete',
  { operation: Schema.String, reason: Schema.String, outputCharacters: Schema.Int },
  { title: 'Incomplete memory generation' },
) {}
/** Give the model the same closed schema used for constrained output and decoding; providers may constrain tokens without explaining the fields to the model. Incomplete output remains a typed failure. */
const complete = Effect.fn('MemoryExtraction.complete')(function* (
  dependencies: {
    readonly client: HttpClient.HttpClient
    readonly key: Redacted.Redacted
    readonly model: string
  },
  input: {
    readonly name: string
    readonly prompt: string
    readonly content: Schema.Json
    readonly schema: Schema.Json
  },
) {
  const body = {
    model: dependencies.model,
    messages: [
      {
        role: 'system',
        content: `${input.prompt}\nRequired JSON schema: ${JSON.stringify(input.schema)}`,
      },
      { role: 'user', content: JSON.stringify(input.content) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: input.name, strict: true, schema: input.schema },
    },
    // Reasoning can use up max_tokens before any structured content is written, so a bounded
    // background pass asks for as little of it as the gateway allows. The gateway refuses turning
    // it off on this model ("effort 'none' is not supported"); `low` is its smallest setting.
    reasoning_effort: 'low',
    temperature: 0,
    max_tokens: 4096,
  }
  const response = yield* providerResponse(dependencies.client, {
    key: dependencies.key,
    path: 'chat/completions',
    body,
  })
  const chat = yield* decodeChat(response).pipe(
    Effect.mapError(() => ProviderMalformed.make({ operation: input.name })),
  )
  const first = chat.choices[0]
  if (first === undefined)
    return yield* Effect.fail(ProviderMalformed.make({ operation: input.name }))
  if (
    !['stop', 'length'].includes(first.finish_reason) ||
    first.message.content.trim().length === 0
  )
    return yield* Effect.fail(
      MemoryGenerationIncomplete.make({
        operation: input.name,
        reason: first.finish_reason,
        outputCharacters: first.message.content.length,
      }),
    )
  if (first.finish_reason === 'length')
    return Completion.cases.BudgetReached.make({ text: first.message.content })
  return Completion.cases.Finished.make({ text: first.message.content })
})

/** The schema determines whether a budget-limited response is complete; a finished JSON value is usable, while truncated JSON retains its precise failure. */
export function completionDecoder<A>(
  decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
  operation: string,
) {
  return Effect.fn('MemoryExtraction.decode')(function* (completion: Completion) {
    return yield* decode(completion.text).pipe(
      Effect.mapError(() =>
        Completion.match(completion, {
          Finished: (): ProviderMalformed | MemoryGenerationIncomplete =>
            ProviderMalformed.make({ operation }),
          BudgetReached: ({ text }) =>
            MemoryGenerationIncomplete.make({
              operation,
              reason: 'length',
              outputCharacters: text.length,
            }),
        }),
      ),
    )
  })
}

export interface MemoryModelService {
  readonly complete: (input: {
    readonly name: string
    readonly prompt: string
    readonly content: Schema.Json
    readonly schema: Schema.Json
  }) => Effect.Effect<Completion, ProviderFailure | MemoryGenerationIncomplete>
}

/** The existing memory model is shared by background text tasks; there is one provider adapter. */
export class MemoryModel extends Context.Service<MemoryModel, MemoryModelService>()(
  'vivid/MemoryModel',
) {}

/**
 * Resolve configuration once in the owning Layer. A missing gateway key or a malformed model name
 * stops launch naming the variable: before, the failure was captured here and handed back on
 * every later completion, so the server ran for its whole life naming no Thread and learning
 * nothing. The gateway not answering is still a typed failure on the one completion that met it.
 */
export const memoryModelLayer = Layer.effect(
  MemoryModel,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const key = yield* modelGatewayKey
    const model = Option.getOrElse(
      yield* optionalSetting('VIVID_MEMORY_MODEL', Schema.NonEmptyString, 'a model name'),
      () => 'glm-5.3-flash',
    )
    return MemoryModel.of({
      complete: Effect.fn('MemoryModel.complete')((input) =>
        complete({ client, key, model }, input),
      ),
    })
  }),
)
