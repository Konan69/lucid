import { RunFailure, RunId, ThreadId } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { FailureAttribute, observeFailures } from '../observability/failure.ts'

/** Only HTTP failure status numbers cross the telemetry boundary, never provider prose. */
export const ProviderStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))

/** Classification distinguishes failed model calls from delivery or unrecognized execution failures. */
const ModelFailureReason = RunFailure.pick([
  'RateLimited',
  'ModelUnavailable',
  'NoAnswer',
  'TimedOut',
])
const isModelFailure = Schema.is(ModelFailureReason)

/** Flue serializes provider failures; only diagnostic evidence, never private payloads, is read here. */
const Evidence = Schema.Union([
  Schema.String,
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    _tag: Schema.optionalKey(RunFailure),
    meta: Schema.optionalKey(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })),
  }),
])
export const decodeFailureEvidence = Schema.decodeUnknownOption(Evidence)
const isText = Schema.is(Schema.String)

/** The SDK's nested reason outranks its generic message; prose stays local to this ingress. */
const diagnosticOf = (evidence: typeof Evidence.Type): Option.Option<string> => {
  if (isText(evidence)) return Option.some(evidence)
  if (evidence.meta !== undefined && evidence.meta.reason !== undefined)
    return Option.some(evidence.meta.reason)
  return Option.fromUndefinedOr(evidence.message)
}

/** Pi 0.87.1 preserves OpenAI's "520 <text>" and "520 status code (no body)", or formats
 * JSON bodies as "520: <body>". Read only the leading field, never numbers inside the body. */
const statusOf = (text: string): Option.Option<number> => {
  const match = /^([45]\d{2})(?: |:)/u.exec(text)
  return match === null ? Option.none() : Option.some(Number(match[1]))
}

/** Only the numeric status survives the SDK evidence ingress; its body stays in this process. */
export const providerStatusOf = (decoded: Option.Option<typeof Evidence.Type>) =>
  Option.flatMap(Option.flatMap(decoded, diagnosticOf), statusOf)

/** The provider's schema-encoded SDK diagnostic is read exactly, before legacy prose classification. */
const decodeReason = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: RunFailure })),
)
const reasonOf = (text: string): RunFailure => {
  const reason = decodeReason(text)
  return Option.isSome(reason) ? reason.value._tag : classifyText(text)
}

/**
 * The one server ingress for provider failure classification. SDK error envelopes and Vivid's
 * tagged provider errors converge here; unrecognized evidence is the only Unexplained case.
 */
export const classifyFailure = (decoded: Option.Option<typeof Evidence.Type>): RunFailure => {
  if (Option.isNone(decoded)) return 'Unexplained'
  const evidence = decoded.value
  if (isText(evidence)) return reasonOf(evidence)
  if (evidence._tag !== undefined) return evidence._tag
  return Option.match(diagnosticOf(evidence), { onNone: () => 'Unexplained', onSome: reasonOf })
}

/** Provider status and known failure phrases outrank generic SDK operation names. */
const classifyText = (text: string): RunFailure => {
  const status = statusOf(text)
  // A gateway's HTML timeout page is still an HTTP 5xx, regardless of the prose in its body.
  if (Option.isSome(status) && status.value >= 500) return 'ModelUnavailable'
  if (/\b429\b|rate.?limit|too many requests/iu.test(text)) return 'RateLimited'
  if (/idle timeout|request timed out|timedout|timed out|deadline|timeout/iu.test(text))
    return 'TimedOut'
  if (/noanswer|empty (?:answer|completion)|no text and no tool/iu.test(text)) return 'NoAnswer'
  if (
    /\b5\d\d\b|modelunavailable|modelconfigurationinvalid|unauthorized|forbidden|authentication|invalid api.?key|\b40[123]\b|model.?not.?found|no (?:credit|endpoints)|insufficient (?:credit|fund)|payment required|\b402\b|model .* (?:not found|does not exist)|connection (?:refused|error)/iu.test(
      text,
    )
  )
    return 'ModelUnavailable'
  return 'Unexplained'
}

/** The provider failed to answer; identities remain local and all diagnostics are closed values. */
export class ModelProviderFailed extends Schema.TaggedError<ModelProviderFailed>()(
  'ModelProviderFailed',
  {
    threadId: ThreadId,
    runId: RunId,
    reason: ModelFailureReason,
    status: Schema.Option(ProviderStatus),
  },
  { title: 'The model provider failed' },
) {}

/** A terminal failure without provider evidence must not be mislabeled as a provider outage. */
export class RunFailed extends Schema.TaggedError<RunFailed>()(
  'RunFailed',
  {
    threadId: ThreadId,
    runId: RunId,
    reason: RunFailure.pick(['Delivery', 'Unexplained']),
  },
  { title: 'The Run failed' },
) {}

/** Give a value settlement an actual failed span before answering it, using the normal recorder.
 * Never attach Flue's serialized error, its prose or a cause; only typed, classified evidence. */
const failRun = Effect.fn('Runtime.failedRun')(function* (input: {
  readonly threadId: ThreadId
  readonly runId: RunId
  readonly reason: RunFailure
  readonly status: Option.Option<number>
}) {
  // Delivery and unrecognized execution failures have their own tag, without model diagnostics.
  const attributes = isModelFailure(input.reason)
    ? Option.match(input.status, {
        onNone: () => ({ [FailureAttribute.modelReason]: input.reason }),
        onSome: (status) => ({
          [FailureAttribute.modelReason]: input.reason,
          [FailureAttribute.modelStatus]: status,
        }),
      })
    : {}
  yield* Effect.annotateCurrentSpan(attributes)
  const failure = isModelFailure(input.reason)
    ? new ModelProviderFailed({ ...input, reason: input.reason })
    : new RunFailed({ threadId: input.threadId, runId: input.runId, reason: input.reason })
  return yield* Effect.fail(failure).pipe(
    observeFailures('runtime'),
    Effect.annotateLogs(attributes),
  )
})

/** Reporting answers only the failure it just constructed; settlement publishing continues. */
export const recordRunFailure = (input: Parameters<typeof failRun>[0]) =>
  failRun(input).pipe(Effect.catchTag(['ModelProviderFailed', 'RunFailed'], () => Effect.void))
