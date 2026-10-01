import { RunFailure } from '@vivid/contracts'
import { Option, Schema } from 'effect'

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
  if (evidence.meta !== undefined && evidence.meta.reason !== undefined)
    return reasonOf(evidence.meta.reason)
  if (evidence.message !== undefined) return reasonOf(evidence.message)
  return 'Unexplained'
}

/** Provider status and known failure phrases outrank generic SDK operation names. */
const classifyText = (text: string): RunFailure => {
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
