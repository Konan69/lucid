import type { ProviderStreams, StreamOptions } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { HarnessSettings } from '@earendil-works/pi-durable'
import { Option } from 'effect'
import { witness } from './witness.ts'

/** Both gateways speak Chat Completions; its lazy adapter loads only when a request needs it. */
const completions = openAICompletionsApi()

/** Pi owns abortable provider backoff; honor Retry-After without an arbitrary delay ceiling. */
const requestBudget = { maxRetries: 2, maxRetryDelayMs: 0 }

/**
 * Durable generation.js and compaction.js forward settings.stream into pi-ai. settings.retry
 * instead owns durable generation attempts, whose default three retries preserve main's turn
 * recovery. Keep those defaults and bound only HTTP establishment here. The witness separately
 * replays one readable empty 400, so a request can still make up to six HTTP sends.
 */
export const settings = { stream: requestBudget } satisfies HarnessSettings

/** Wrap only transport evidence; retry policy arrives from the Harness rather than the provider. */
const observed = <Given extends Pick<StreamOptions, 'fetch'>>(options: Option.Option<Given>) =>
  Option.match(options, {
    onNone: () => ({ fetch: witness(globalThis.fetch.bind(globalThis)) }),
    onSome: (given) => ({
      ...given,
      fetch: witness(
        Option.getOrElse(Option.fromUndefinedOr(given.fetch), () =>
          globalThis.fetch.bind(globalThis),
        ),
      ),
    }),
  })

/** Both gateways witness the caller's fetch, or the platform fetch, at Pi's public request seam. */
export const witnessed: ProviderStreams = {
  stream: (model, context, options) =>
    completions.stream(model, context, observed(Option.fromUndefinedOr(options))),
  streamSimple: (model, context, options) =>
    completions.streamSimple(model, context, observed(Option.fromUndefinedOr(options))),
}
