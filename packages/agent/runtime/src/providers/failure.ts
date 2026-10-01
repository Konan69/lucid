import { Predicate, Schema } from 'effect'

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
  /** Flue serializes Error.message; this stable marker survives its operation envelope. */
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
  /** Stable failure text is classified once at the server ingress. */
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
  /** The deadline marker survives Flue's Error serialization. */
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
) {}

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

export type ModelFailure =
  | RateLimited
  | ModelUnavailable
  | NoAnswer
  | TimedOut
  | TurnStopped
  | ModelConfigurationInvalid
  | ProviderRejected

/** SDK-decoded status evidence chooses retryability without copying sensitive provider diagnostics. */
export const providerFailure = (model: ModelName, message: string): ModelFailure => {
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return new RateLimited({ model })
  if (/idle timeout|timed out|timeout/iu.test(message)) return new TimedOut({ model })
  if (/\b5\d\d\b|connection|network/iu.test(message))
    return new ModelUnavailable({ model, transient: true })
  if (
    /\b402\b|no (?:credit|endpoints)|insufficient (?:credit|fund)|model.?not.?found|model .* (?:not found|does not exist)|payment required/iu.test(
      message,
    )
  )
    return new ModelUnavailable({ model, transient: false })
  return new ProviderRejected({ model })
}

/** Deterministic refusals skip retries; an attempt timeout may try the next attempt within the shared deadline. */
export const retryable = (failure: ModelFailure): boolean => {
  if (Predicate.isTagged(failure, 'ModelUnavailable')) return failure.transient
  return (
    Predicate.isTagged(failure, 'RateLimited') ||
    Predicate.isTagged(failure, 'NoAnswer') ||
    Predicate.isTagged(failure, 'TimedOut')
  )
}
