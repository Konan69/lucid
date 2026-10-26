import { Option, Predicate, Schema } from 'effect'

/**
 * Executor's `accountRouter` (refs/executor at executor@2.0.0-beta.23,
 * packages/apps/src/implementation/account-router.ts `merge` and `combineOperation`) is how every
 * Integration whose members link their own accounts lists its tools: an imported MCP server with
 * sign-in among them (packages/app-templates/src/implementation/mcp.ts). It merges each tool across
 * the linked accounts, and a call then takes `{ accountId, input }`, where `accountId` picks the
 * account and `input` is the provider's own input. The listed input schema is one `anyOf` branch
 * per account, each nesting the provider's schema under `properties.input` with its `$ref`s
 * rewritten to `#/anyOf/<index>/properties/input/...` (`nestJsonSchema`); the output schema, when
 * every account declares one, is an `anyOf` of the outputs in the same order.
 *
 * Vivid binds each Connection to exactly one account, so the choice of account is Vivid's, never the
 * model's: the model must see the provider's input as the provider wrote it and must never see the
 * Executor account identifier. This module reads the branch that belongs to the Connection's own
 * account back out of the envelope; the adapter adds `accountId` again when it calls.
 */

const Envelope = Schema.Struct({ type: Schema.Literal('object'), anyOf: Schema.Array(Schema.Json) })
const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const Branch = Schema.Struct({
  type: Schema.Literal('object'),
  required: Schema.Array(Schema.String),
  properties: Schema.Struct({
    accountId: Schema.Struct({ type: Schema.Literal('string'), const: Schema.String }),
    input: Schema.Json,
  }),
})
const decodeBranch = Schema.decodeUnknownOption(Branch)
const Outputs = Schema.Struct({ anyOf: Schema.Array(Schema.Json) })
const decodeOutputs = Schema.decodeUnknownOption(Outputs)

/** JSON is already decoded; keep its value type when telling a record from a readonly array. */
const isRecord = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** A reference into the nested document becomes the same reference from that document's root.
 * One that points elsewhere is left as it was: the renderer then reads it as unknown. */
function relocated(reference: string, pointer: string) {
  if (reference === pointer) return '#'
  return reference.startsWith(`${pointer}/`) ? `#${reference.slice(pointer.length)}` : reference
}

/** Undo `nestJsonSchema`'s pointer rewrite for every `$ref` and `$recursiveRef` in the subtree. */
function rebase(value: Schema.Json, pointer: string): Schema.Json {
  if (Array.isArray(value)) return value.map((item: Schema.Json) => rebase(item, pointer))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === '$ref' || key === '$recursiveRef') && Predicate.isString(item)
        ? relocated(item, pointer)
        : rebase(item, pointer),
    ]),
  )
}

/** The account's own branch, when the listed input is Executor's account envelope. */
export interface AccountBranch {
  readonly input: Schema.Json
  readonly output: Option.Option<Schema.Json>
}

/**
 * The provider's input and output schemas for `account`, read out of Executor's account envelope.
 * None when the input is not an envelope with a branch for this exact account: then the listed
 * schema is the provider's own and calls send the input unchanged. Matching on the account's own
 * identifier means a provider schema cannot be mistaken for an envelope by its shape alone.
 */
export function accountBranch(
  tool: { readonly input: Schema.Json; readonly output: Option.Option<Schema.Json> },
  account: string,
): Option.Option<AccountBranch> {
  const envelope = decodeEnvelope(tool.input)
  if (Option.isNone(envelope)) return Option.none()
  const own = envelope.value.anyOf
    .flatMap((candidate, index) =>
      Option.match(decodeBranch(candidate), {
        onNone: () => [],
        onSome: (branch) => [{ index, branch }],
      }),
    )
    .find(
      ({ branch }) =>
        branch.properties.accountId.const === account &&
        branch.required.includes('accountId') &&
        branch.required.includes('input'),
    )
  if (own === undefined) return Option.none()
  const { index, branch } = own
  return Option.some({
    input: rebase(branch.properties.input, `#/anyOf/${index}/properties/input`),
    output: Option.map(tool.output, (output) =>
      Option.match(
        Option.flatMap(decodeOutputs(output), (outputs) =>
          Option.fromUndefinedOr(outputs.anyOf[index]),
        ),
        {
          onNone: () => output,
          onSome: (branchOutput) => rebase(branchOutput, `#/anyOf/${index}`),
        },
      ),
    ),
  })
}
