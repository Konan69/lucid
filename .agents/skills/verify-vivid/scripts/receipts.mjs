import { Result, Schema } from 'effect'

/** Local process handoffs carry no product authority. Shared codecs also keep cookies in scratch. */
export const Account = Schema.Struct({ cookie: Schema.String })
/** Worker health proves its fetch handler loaded. A real journey proves the selected model. */
export const RuntimeHealth = Schema.Struct({
  status: Schema.String,
  service: Schema.String,
})
export const Ready = Schema.TaggedStruct('Ready', {})
export const decodeText = (schema, text) =>
  Result.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text))

/** Bucket secrets are private handoffs. Native state retains celld's counters for later audit. */
export const BucketCredentials = Schema.Struct({
  access: Schema.NonEmptyString,
  secret: Schema.NonEmptyString,
})
export const NativeState = Schema.StructWithRest(
  Schema.Struct({
    deployment: Schema.StructWithRest(Schema.Struct({ version: Schema.String }), [
      Schema.Record(Schema.String, Schema.Json),
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

/** celld 0.6.2's JSON deployment receipt does not contain a reusable bundle. */
export const NativeDeployment = Schema.Struct({
  worker: Schema.Literal('vivid-cells'),
  version: Schema.NonEmptyString,
  location: Schema.String,
  dry_run: Schema.Literal(false),
})
