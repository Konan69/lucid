import { Schema } from 'effect'

/** Wire metadata identifies recorded entries by their numeric JSON identity.
 * It carries no Pi authority or branded SDK type into browser/native clients. */
export const ResponseDuration = Schema.Struct({ entryId: Schema.Int, durationMs: Schema.Finite })
export const ToolDuration = Schema.Struct({
  entryId: Schema.Int,
  toolCallId: Schema.String,
  toolName: Schema.String,
  durationMs: Schema.Finite,
})
export const Model = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  responseModel: Schema.optionalKey(Schema.String),
})
/** Provider token counts are finite; JSON cannot retain NaN or infinities. */
export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cacheWrite1h: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
})

/** One schema owns the server and client contract. Pi records monotonic attempt
 * durations separately from task wall-clock lifecycle stamps; entry identity
 * distinguishes retries and reused provider call ids. Missing reports stay absent. */
export const Metadata = Schema.Struct({
  models: Schema.Array(Model),
  usage: Schema.optionalKey(Tokens),
  failure: Schema.optionalKey(Schema.String),
  responses: Schema.optionalKey(Schema.Array(ResponseDuration)),
  tools: Schema.optionalKey(Schema.Array(ToolDuration)),
})
export type Metadata = typeof Metadata.Type
