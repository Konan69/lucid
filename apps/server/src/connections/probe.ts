import { Option, Schema } from 'effect'
import { ExecutorReferences } from './executor.ts'

const ObjectInput = Schema.Struct({
  type: Schema.Literal('object'),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeObject = Schema.decodeUnknownOption(ObjectInput)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))
const Branch = Schema.Struct({
  type: Schema.Literal('object'),
  required: Schema.Array(Schema.String),
  properties: Schema.Struct({
    accountId: Schema.Struct({ type: Schema.Literal('string'), const: Schema.String }),
    input: Schema.Json,
  }),
})
const decodeBranch = Schema.decodeUnknownOption(Branch)
const Envelope = Schema.Struct({ type: Schema.Literal('object'), anyOf: Schema.Array(Schema.Json) })
const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
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

/** Executor accountOperations wraps provider inputs in { accountId, input } and advertises one
 * anyOf branch per selected account (apps implementation/account-operations). Only the account
 * already bound to this Connection may satisfy that envelope; the model never supplies its id.
 * Provider JSON Schema is a second ingress contract within the decoded tool JSON document.
 */
export function testInput(
  input: Schema.Json,
  references: ExecutorReferences,
): Option.Option<Schema.Json> {
  if (acceptsEmpty(input)) return Option.some({})
  if (!ExecutorReferences.guards.Authorized(references)) return Option.none()
  const envelope = decodeEnvelope(input)
  if (Option.isNone(envelope) || !onlyKeywords(input, ['type', 'anyOf', ...metadata]))
    return Option.none()
  const branches = envelope.value.anyOf.filter((branch) =>
    onlyKeywords(branch, ['type', 'properties', 'required', 'additionalProperties', ...metadata]),
  )
  const branch = branches
    .map((value) => decodeBranch(value))
    .find(
      (candidate) =>
        Option.isSome(candidate) &&
        candidate.value.properties.accountId.const === references.account,
    )
  if (branch === undefined || Option.isNone(branch)) return Option.none()
  if (
    branch.value.required.length !== 2 ||
    !branch.value.required.includes('accountId') ||
    !branch.value.required.includes('input')
  )
    return Option.none()
  if (!acceptsEmpty(branch.value.properties.input)) return Option.none()
  return Option.some({ accountId: references.account, input: {} })
}
