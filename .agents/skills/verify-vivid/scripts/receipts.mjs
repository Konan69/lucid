import { Result, Schema } from 'effect'

/** Local process handoffs carry no product authority. Shared codecs also keep cookies in scratch. */
export const Account = Schema.Struct({ cookie: Schema.String })
export const Ready = Schema.TaggedStruct('Ready', {})
export const decodeText = (schema, text) =>
  Result.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text))
