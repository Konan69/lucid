import type { ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/** Pi's Chat Completions adapter, which every provider Vivid declares speaks. */
export const completions = openAICompletionsApi()

/**
 * Pi 0.87.1 openai-completions retries only create(...).withResponse(), before emitting start
 * or consuming the stream. Its public options cover 5xx (including 520–524) and connection
 * failures, as well as 408/409/429 and provider retry headers; defaults are zero retries.
 * Allow two retries per Pi request; a server-requested wait above 2 s fails immediately.
 * Flue 2.2.2 useModel has no request options, so supply these at its public Provider API seam.
 * This adapter never replays a stream after assistant content or a tool delta. Flue separately
 * retries some failed turns up to three times, without a public content guard or retry option:
 * those errors can therefore make up to twelve HTTP requests and replay partial output.
 */
export const requestBudget = { maxRetries: 2, maxRetryDelayMs: 2_000 }

/** Chat Completions with the request budget applied, for a provider that adds nothing else. */
export const budgeted: ProviderStreams = {
  stream: (model, context, options) =>
    completions.stream(model, context, { ...options, ...requestBudget }),
  streamSimple: (model, context, options) =>
    completions.streamSimple(model, context, { ...options, ...requestBudget }),
}
