import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { Option, Schema } from 'effect'

const isEntryId = Schema.is(Schema.Int)
const EntryIdentity = Schema.declare<EntryId>((value): value is EntryId => isEntryId(value))
const ResponseDuration = Schema.Struct({ entryId: EntryIdentity, durationMs: Schema.Finite })
const ToolDuration = Schema.Struct({
  entryId: EntryIdentity,
  toolCallId: Schema.String,
  toolName: Schema.String,
  durationMs: Schema.Finite,
})

const Model = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  responseModel: Schema.optionalKey(Schema.String),
})
/** Provider token counts are finite; JSON cannot retain NaN or infinities. */
const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cacheWrite1h: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
})
/** Provider counts are untrusted even though Pi types them as numbers. Reject the whole response's
 * accounting when one count is invalid: retaining a subset would mix incompatible totals. Costs
 * are monetary records; the token decoder projects only the count vocabulary. */
const decodeTokens = Schema.decodeUnknownOption(Tokens)

/** Pi 1.1.0 generation.ts records response duration; tool.ts:appendToolResult
 * records execute duration. Entry identity distinguishes retries and reused call ids.
 * These are monotonic attempt durations, never task wall-clock lifecycle spans. */
export const Metadata = Schema.Struct({
  models: Schema.Array(Model),
  usage: Schema.optionalKey(Tokens),
  failure: Schema.optionalKey(Schema.String),
  responses: Schema.optionalKey(Schema.Array(ResponseDuration)),
  tools: Schema.optionalKey(Schema.Array(ToolDuration)),
})
export type Metadata = typeof Metadata.Type

/** Per-reader entry deduplication mirrors Pi's usage ledger without introducing another store. */
export type MetadataState = {
  readonly models: Metadata['models']
  readonly responses: ReadonlyMap<
    EntryId,
    {
      readonly usage: Option.Option<typeof Tokens.Type>
      readonly durationMs: Option.Option<number>
    }
  >
  readonly tools: ReadonlyMap<EntryId, typeof ToolDuration.Type>
}
export const emptyMetadata: MetadataState = {
  models: [],
  responses: new Map(),
  tools: new Map(),
}

/** Publish the actual model once its provider message exists; agent configuration is not an answer. */
export function startMetadata(state: MetadataState, message: AssistantMessage): MetadataState {
  const modelId = message.model
  let model = Model.make({ provider: message.provider, modelId })
  if (message.responseModel !== undefined)
    model = Model.make({ ...model, responseModel: message.responseModel })
  const known = state.models.findIndex(
    (item) => item.provider === message.provider && item.modelId === modelId,
  )
  if (known !== -1)
    return {
      ...state,
      models: state.models.map((item, index) => (index === known ? { ...item, ...model } : item)),
    }
  return {
    ...state,
    models: [...state.models, model],
  }
}

/** Watch/snapshot overlap must not count the same durable response twice. An invalid usage report
 * contributes no counts, but the response's model still belongs to the message. */
export function recordMetadata(state: MetadataState, entry: EntryRecord): MetadataState {
  if (state.responses.has(entry.id) || state.tools.has(entry.id)) return state
  if (entry.model === undefined) return state
  const tool = entry.model.find((item) => item.role === 'toolResult')
  if (tool !== undefined && tool.durationMs !== undefined)
    return {
      ...state,
      tools: new Map(state.tools).set(
        entry.id,
        ToolDuration.make({
          entryId: entry.id,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          durationMs: tool.durationMs,
        }),
      ),
    }
  const message = entry.model.find((item) => item.role === 'assistant')
  if (message === undefined) return state
  const next = startMetadata(state, message)
  const usage = decodeTokens(message.usage)
  return {
    ...next,
    responses: new Map(next.responses).set(entry.id, {
      usage,
      durationMs: Option.fromNullishOr(message.durationMs),
    }),
  }
}

/** Optional token breakdowns are sums of reported subsets, never estimates for silent providers. */
function sumTokens(total: typeof Tokens.Type, response: typeof Tokens.Type): typeof Tokens.Type {
  let usage = Tokens.make({
    input: total.input + response.input,
    output: total.output + response.output,
    cacheRead: total.cacheRead + response.cacheRead,
    cacheWrite: total.cacheWrite + response.cacheWrite,
    totalTokens: total.totalTokens + response.totalTokens,
  })
  for (const key of ['cacheWrite1h', 'reasoning'] as const) {
    const previous = total[key]
    const current = response[key]
    if (previous !== undefined && current !== undefined)
      usage = Tokens.make({ ...usage, [key]: previous + current })
    else if (previous !== undefined) usage = Tokens.make({ ...usage, [key]: previous })
    else if (current !== undefined) usage = Tokens.make({ ...usage, [key]: current })
  }
  return usage
}

/** Absent completed usage stays absent; recorded zero counts are preserved as recorded zero counts. */
export function messageMetadata(state: MetadataState, failure: Option.Option<string>): Metadata {
  const responses = Array.from(state.responses.values()).flatMap((response) =>
    Option.toArray(response.usage),
  )
  const first = responses[0]
  let metadata =
    first === undefined
      ? Metadata.make({ models: state.models })
      : Metadata.make({ models: state.models, usage: responses.slice(1).reduce(sumTokens, first) })
  const durations = Array.from(state.responses, ([entryId, response]) =>
    Option.map(response.durationMs, (durationMs) => ResponseDuration.make({ entryId, durationMs })),
  ).flatMap(Option.toArray)
  if (durations.length > 0) metadata = Metadata.make({ ...metadata, responses: durations })
  if (state.tools.size > 0)
    metadata = Metadata.make({ ...metadata, tools: [...state.tools.values()] })
  return Option.isSome(failure) ? Metadata.make({ ...metadata, failure: failure.value }) : metadata
}
