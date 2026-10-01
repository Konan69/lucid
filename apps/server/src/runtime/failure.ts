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

/**
 * The one server ingress for provider failure classification. SDK error envelopes and Vivid's
 * tagged provider errors converge here; unrecognized evidence is the only Unexplained case.
 */
export const classifyFailure = (decoded: Option.Option<typeof Evidence.Type>): RunFailure => {
  if (Option.isNone(decoded)) return 'Unexplained'
  const evidence = decoded.value
  if (isText(evidence)) return classifyText(evidence)
  if (evidence._tag !== undefined) return evidence._tag
  const parts: string[] = []
  if (evidence.message !== undefined) parts.push(evidence.message)
  if (evidence.meta !== undefined && evidence.meta.reason !== undefined)
    parts.push(evidence.meta.reason)
  return classifyText(parts.join('\n'))
}

/** Provider status and known failure phrases outrank generic SDK operation names. */
const classifyText = (text: string): RunFailure => {
  if (/\b429\b|rate.?limit|too many requests/iu.test(text)) return 'RateLimited'
  if (/idle timeout|request timed out|timedout|timed out|deadline|timeout/iu.test(text))
    return 'TimedOut'
  if (/noanswer|empty (?:answer|completion)|no text and no tool/iu.test(text)) return 'NoAnswer'
  if (
    /\b5\d\d\b|modelunavailable|model.?not.?found|no (?:credit|endpoints)|insufficient (?:credit|fund)|payment required|\b402\b|model .* (?:not found|does not exist)|connection (?:refused|error)/iu.test(
      text,
    )
  )
    return 'ModelUnavailable'
  return 'Unexplained'
}
