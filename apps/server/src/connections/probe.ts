import { Option, Schema } from 'effect'

const ObjectInput = Schema.Struct({
  type: Schema.Literal('object'),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeObject = Schema.decodeUnknownOption(ObjectInput)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))
const metadata = ['$schema', '$defs', 'title', 'description']

/** An unused definition is metadata; unknown root constraints and compositions prevent automatic calls. */
function onlyKeywords(input: Schema.Json, allowed: readonly string[]) {
  const record = decodeRecord(input)
  return Option.isSome(record) && Object.keys(record.value).every((key) => allowed.includes(key))
}

/** Conservatively prove that {} satisfies an object input; never invent required domain values. */
function acceptsEmpty(input: Schema.Json) {
  const object = decodeObject(input)
  if (Option.isNone(object)) return false
  if (object.value.required !== undefined && object.value.required.length > 0) return false
  return onlyKeywords(input, [
    'type',
    'properties',
    'required',
    'additionalProperties',
    ...metadata,
  ])
}

/** The probe input for a read-only tool: `{}` when it provably satisfies the provider's input, and
 * nothing otherwise. Discovery already shows the provider's own input for an account-bound tool
 * (`envelope.ts`) and the adapter adds the account when it calls, so the probe never names one.
 * Provider JSON Schema is a second ingress contract within the decoded tool JSON document.
 */
export function testInput(input: Schema.Json): Option.Option<Schema.Json> {
  return acceptsEmpty(input) ? Option.some({}) : Option.none()
}
