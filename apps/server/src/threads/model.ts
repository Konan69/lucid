import { Context, Effect, Layer, Option, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { optionalSetting, serverModelGateway, settingText } from '../config.ts'
import { ProviderMalformed, providerResponse, type ProviderFailure } from './provider.ts'

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

export class TitleGenerationIncomplete extends Schema.TaggedError<TitleGenerationIncomplete>()(
  'TitleGenerationIncomplete',
  { operation: Schema.String, reason: Schema.String, outputCharacters: Schema.Int },
  { title: 'Incomplete title generation' },
) {}
/** Give the model the same closed schema used for constrained output and decoding; providers may constrain tokens without explaining the fields to the model. Incomplete output remains a typed failure. */
const complete = Effect.fn('TitleModel.complete')(function* (
  dependencies: {
    readonly client: HttpClient.HttpClient
    readonly gateway: Effect.Success<typeof serverModelGateway>
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
    gateway: dependencies.gateway,
    path: 'chat/completions',
    body,
  })
  const chat = yield* decodeChat(response).pipe(
    Effect.mapError(() => ProviderMalformed.make({ operation: input.name })),
  )
  const first = chat.choices[0]
  if (first === undefined) return yield* ProviderMalformed.make({ operation: input.name })
  if (
    !['stop', 'length'].includes(first.finish_reason) ||
    first.message.content.trim().length === 0
  )
    return yield* TitleGenerationIncomplete.make({
      operation: input.name,
      reason: first.finish_reason,
      outputCharacters: first.message.content.length,
    })
  if (first.finish_reason === 'length')
    return Completion.cases.BudgetReached.make({ text: first.message.content })
  return Completion.cases.Finished.make({ text: first.message.content })
})

/** The schema determines whether a budget-limited response is complete; a finished JSON value is usable, while truncated JSON retains its precise failure. */
export function completionDecoder<A>(
  decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
  operation: string,
) {
  return Effect.fn('TitleModel.decode')(function* (completion: Completion) {
    return yield* decode(completion.text).pipe(
      Effect.mapError(() =>
        Completion.match(completion, {
          Finished: (): ProviderMalformed | TitleGenerationIncomplete =>
            ProviderMalformed.make({ operation }),
          BudgetReached: ({ text }) =>
            TitleGenerationIncomplete.make({
              operation,
              reason: 'length',
              outputCharacters: text.length,
            }),
        }),
      ),
    )
  })
}

export interface TitleModelService {
  readonly complete: (input: {
    readonly name: string
    readonly prompt: string
    readonly content: Schema.Json
    readonly schema: Schema.Json
  }) => Effect.Effect<Completion, ProviderFailure | TitleGenerationIncomplete>
}

/** Thread naming owns this background text provider; conversations use the cell model. */
export class TitleModel extends Context.Service<TitleModel, TitleModelService>()(
  'vivid/TitleModel',
) {}

/**
 * Resolve configuration once in the owning Layer. A missing gateway key or a malformed model name
 * stops launch naming the variable: before, the failure was captured here and handed back on
 * every later completion, so the server ran for its whole life naming no Thread. The gateway not answering is still a typed failure on the one completion that met it.
 */
export const titleModelLayer = Layer.effect(
  TitleModel,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const gateway = yield* serverModelGateway
    const model = Option.getOrElse(
      yield* optionalSetting('VIVID_THREAD_TITLE_MODEL', settingText, 'a model name'),
      () => gateway.titleModel,
    )
    return TitleModel.of({
      complete: Effect.fn('TitleModel.complete')((input) =>
        complete({ client, gateway, model }, input),
      ),
    })
  }),
)
