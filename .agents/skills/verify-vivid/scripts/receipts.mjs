import { Result, Schema } from 'effect'

/** Local process handoffs carry no product authority. Shared codecs also keep cookies in scratch. */
export const Account = Schema.Struct({ cookie: Schema.String })
/** Runtime readiness includes the selected model, not merely an open HTTP port. */
export const RuntimeHealth = Schema.Struct({
  model: Schema.String,
  status: Schema.String,
  service: Schema.String,
})
export const Ready = Schema.TaggedStruct('Ready', {})
export const decodeText = (schema, text) =>
  Result.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text))
