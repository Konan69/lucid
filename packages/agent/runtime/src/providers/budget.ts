import type { ProviderStreams, StreamOptions } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { Option } from 'effect'
import { witness } from './witness.ts'

/** Pi's Chat Completions adapter, which every provider Vivid declares speaks. */
export const completions = openAICompletionsApi()

/**
 * Pi 0.87.1 openai-completions retries only create(...).withResponse(), before emitting start
 * or consuming the stream. Its public options cover 5xx (including 520–524) and connection
 * failures, as well as 408/409/429 and provider retry headers; defaults are zero retries.
 * Allow two retries per Pi request; a server-requested wait above 2 s fails immediately.
 * Flue 2.2.2 useModel has no request options, so supply these at its public Provider API seam.
 * `witness.ts` separately replays one empty HTTP 400; Pi's budget still owns every other status.
 * This adapter never replays a stream after assistant content or a tool delta. Flue separately
 * retries some failed turns up to three times, without a public content guard or retry option:
 * each of Pi's three attempts can send an empty 400 followed by a retryable failure (six HTTP
 * requests per Pi request). Four Flue turn attempts can therefore make twenty-four HTTP
 * requests and replay partial output.
 */
export const requestBudget = { maxRetries: 2, maxRetryDelayMs: 2_000 }

/** Preserve caller options while the shared seam owns its bounded retries and HTTP evidence. */
const budget = <Given extends Pick<StreamOptions, 'fetch'>>(options: Option.Option<Given>) =>
  Option.match(options, {
    onNone: () => ({ ...requestBudget, fetch: witness(globalThis.fetch.bind(globalThis)) }),
    onSome: (given) => ({
      ...given,
      ...requestBudget,
      fetch: witness(
        Option.getOrElse(Option.fromUndefinedOr(given.fetch), () =>
          globalThis.fetch.bind(globalThis),
        ),
      ),
    }),
  })

/** Both gateways witness the caller's fetch (or the platform fetch) at Pi's public request seam. */
export const budgeted: ProviderStreams = {
  stream: (model, context, options) =>
    completions.stream(model, context, budget(Option.fromUndefinedOr(options))),
  streamSimple: (model, context, options) =>
    completions.streamSimple(model, context, budget(Option.fromUndefinedOr(options))),
}
