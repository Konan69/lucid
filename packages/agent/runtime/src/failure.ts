import { RunFailure } from '@vivid/contracts'
import { Option, Schema } from 'effect'

/**
 * Why a response could not be answered, in the product's closed words. This is the one place a
 * provider's or the conversation library's failure text is read. The text stays here: it can
 * quote a request, a path or a key, so only the category and an HTTP status number leave the
 * runtime (`RuntimeSettlement.Failed`).
 *
 * The reading is the application server's (`apps/server/src/runtime/failure.ts`, `statusOf` and
 * `classifyText`), moved to where the text now is. pi-ai keeps a provider's "520 <text>" and
 * "520 status code (no body)", or formats a JSON body as "520: <body>", and may put a fixed
 * retry-delay sentence before it; only the status after that exact prefix is read, never a
 * number inside the body.
 */
const statusOf = (text: string): Option.Option<number> => {
  const match = /^(?:Server requested \d+s retry delay \(max: \d+s\)\. )?([45]\d{2})(?: |:)/u.exec(
    text,
  )
  const status = match === null ? undefined : match[1]
  return status === undefined ? Option.none() : Option.some(Number(status))
}

/** Provider status and known failure phrases outrank generic operation names. */
const classifyText = (text: string, status: Option.Option<number>): RunFailure => {
  // Every parsed HTTP failure is provider evidence, independent of the prose in its body.
  if (Option.isSome(status)) {
    if (status.value === 429) return 'RateLimited'
    if (status.value === 408) return 'TimedOut'
    return 'ModelUnavailable'
  }
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

const decodeFailure = Schema.decodeUnknownOption(RunFailure)
const decodeWords = Schema.decodeUnknownOption(Schema.String)

/**
 * Classify one unanswered input from Pi's durable reason and detail (`generation.ts`: `no_model`
 * with no detail, `model_error` with the provider's text; `live.ts`: `faulted` with a task's
 * message). A reason with no words to read is `Unexplained`, except a missing model.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi stores a failure's detail as JSON of any shape; it is decoded here.
export const classify = (reason: string, detail: unknown) => {
  // An explicit product category outranks diagnostic text that may describe a different attempt.
  const saved = decodeFailure(reason)
  if (Option.isSome(saved)) return { failure: saved.value, status: Option.none<number>() }
  if (reason === 'no_model')
    return { failure: 'ModelUnavailable' as const, status: Option.none<number>() }
  return Option.match(decodeWords(detail), {
    onNone: () => ({ failure: 'Unexplained' as const, status: Option.none<number>() }),
    onSome: (text) => {
      const status = statusOf(text)
      return { failure: classifyText(text, status), status }
    },
  })
}
