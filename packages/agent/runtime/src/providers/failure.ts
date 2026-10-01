import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { RunFailure } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'

/** A model name is provider-qualified at configuration and local to its provider at the SDK seam. */
export const ModelName = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand('ModelName'))
export type ModelName = typeof ModelName.Type

/** Retrying a rate limit is safe only before any content or tool call has escaped the adapter. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  {
    model: ModelName,
  },
  { title: 'Model rate limited' },
) {
  /** Local diagnostics stay caller-safe; wire classification uses the terminal event's typed tag. */
  override get message() {
    return 'RateLimited: provider returned 429'
  }
}
/** Billing and missing models fall through immediately; transient server failures may retry first. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  'ModelUnavailable',
  {
    model: ModelName,
    transient: Schema.Boolean,
  },
  { title: 'Model unavailable' },
) {
  /** Private provider payloads never enter Flue's serialized failure. */
  override get message() {
    return 'ModelUnavailable: provider could not serve the model'
  }
}
/** An empty successful completion must fail without publishing a placeholder assistant Message. */
export class NoAnswer extends Schema.TaggedError<NoAnswer>()(
  'NoAnswer',
  { model: ModelName },
  { title: 'Model returned no answer' },
) {
  /** Local diagnostics describe empty output without including the provider payload. */
  override get message() {
    return 'NoAnswer: no text and no tool call'
  }
}
/** The first meaningful token must arrive within one budget covering retries and every fallback. */
export class TimedOut extends Schema.TaggedError<TimedOut>()(
  'TimedOut',
  { model: ModelName },
  { title: 'Model first token timed out' },
) {
  /** Local deadline diagnostics never expose request details. */
  override get message() {
    return 'TimedOut: first token deadline exceeded'
  }
}
/** Aborted turns never retry or select another model. */
export class TurnStopped extends Schema.TaggedError<TurnStopped>()(
  'TurnStopped',
  {
    model: ModelName,
  },
  { title: 'Model turn stopped' },
) {}

/** Invalid operator configuration is distinct from provider unavailability. */
export class ModelConfigurationInvalid extends Schema.TaggedError<ModelConfigurationInvalid>()(
  'ModelConfigurationInvalid',
  {},
  { title: 'Invalid model configuration' },
) {
  /** Configuration needs operator intervention and never includes the supplied private value. */
  override get message() {
    return 'ModelUnavailable: invalid model configuration'
  }
}

/** Refusals outside availability, rate limits, timeouts, and emptiness remain unclassified at the server. */
export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()(
  'ProviderRejected',
  { model: ModelName },
  { title: 'Provider refused the request' },
) {
  /** The stable diagnostic avoids leaking the provider's request details. */
  override get message() {
    return 'ProviderRejected: provider refused the request'
  }
}

/** One failure vocabulary drives runtime typing, retry guards, and exhaustive wire classification. */
const Failures = Schema.Union([
  RateLimited,
  ModelUnavailable,
  NoAnswer,
  TimedOut,
  TurnStopped,
  ModelConfigurationInvalid,
  ProviderRejected,
]).pipe(Schema.toTaggedUnion('_tag'))
const isFailure = Schema.is(Failures)
export type ModelFailure = typeof Failures.Type

/** SDK-decoded status evidence chooses retryability without copying sensitive provider diagnostics. */
export const providerFailure = (model: ModelName, message: string): ModelFailure => {
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return new RateLimited({ model })
  if (/idle timeout|timed out|timeout/iu.test(message)) return new TimedOut({ model })
  if (/\b5\d\d\b|connection|network/iu.test(message))
    return new ModelUnavailable({ model, transient: true })
  if (
    /\b40[123]\b|unauthorized|forbidden|authentication|invalid api.?key|no (?:credit|endpoints)|insufficient (?:credit|fund)|model.?not.?found|model .* (?:not found|does not exist)|payment required/iu.test(
      message,
    )
  )
    return new ModelUnavailable({ model, transient: false })
  return new ProviderRejected({ model })
}

/** Deterministic refusals skip retries; an attempt timeout may try the next attempt within the shared deadline. */
const isRetryable = Failures.isAnyOf(['RateLimited', 'NoAnswer', 'TimedOut'])
export const retryable = (failure: ModelFailure): boolean => {
  if (Failures.guards.ModelUnavailable(failure)) return failure.transient
  return isRetryable(failure)
}

/** Only recognized SDK/network failures may enter the retry channel; arbitrary rejections are defects. */
const Rejection = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
})
const decodeRejection = Schema.decodeUnknownOption(Rejection)

/** An iterator rejection is an unsafe SDK ingress, distinct from its normal terminal error events. */
export const readModelEvent = (iterator: AsyncIterator<AssistantMessageEvent>, model: ModelName) =>
  Effect.tryPromise({ try: () => iterator.next(), catch: (error) => error }).pipe(
    Effect.catch((error): Effect.Effect<never, ModelFailure> => {
      if (isFailure(error)) return Effect.fail(error)
      const evidence = decodeRejection(error)
      if (Option.isNone(evidence)) return Effect.die(error)
      const value = evidence.value
      if (value.name === 'AbortError') return Effect.fail(new TurnStopped({ model }))
      if (value.status !== undefined)
        return Effect.fail(providerFailure(model, String(value.status)))
      if (
        /^(?:APIError|APIConnectionError|APIConnectionTimeoutError|FetchError)$/u.test(value.name)
      )
        return Effect.fail(providerFailure(model, value.message))
      return Effect.die(error)
    }),
  )

const FailureReason = Schema.fromJsonString(Schema.Struct({ _tag: RunFailure }))
const encodeReason = Schema.encodeSync(FailureReason)

/** pi-ai errorMessage is the provider-owned diagnostic field consumed by Flue's error-event path. */
export const failureDiagnostic = (failure: ModelFailure): string =>
  encodeReason({
    _tag: Failures.match(failure, {
      RateLimited: (): RunFailure => 'RateLimited',
      ModelUnavailable: (): RunFailure => 'ModelUnavailable',
      NoAnswer: (): RunFailure => 'NoAnswer',
      TimedOut: (): RunFailure => 'TimedOut',
      TurnStopped: (): RunFailure => 'Unexplained',
      ModelConfigurationInvalid: (): RunFailure => 'ModelUnavailable',
      ProviderRejected: (): RunFailure => 'Unexplained',
    }),
  })
