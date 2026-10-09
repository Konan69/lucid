import { createProvider, envApiKeyAuth, type ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { setProvider } from '@flue/runtime'

/**
 * Vivid's model provider: the Experiential Labs gateway, which speaks OpenAI's Chat Completions.
 * One base address, one key (`EXPLABS_API_KEY`), and a model named by the gateway's own id, so
 * `VIVID_MODEL` is `explabs/<id>`. Pi retries request establishment before streaming;
 * the gateway owns failover between upstream providers.
 *
 * A model Vivid may be pointed at is declared below with the limits Pi needs to run it. To use
 * another of the gateway's models, add it here with its id exactly as `GET /v1/models` returns it.
 */
const baseUrl = 'https://api.experientiallabs.ai/v1'

/** US dollars per million tokens, as the gateway's catalogue lists them. */
interface Rates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/**
 * GLM 5.3 Flash and its variants share one context window and output limit. The rates are for
 * Pi's own accounting; what a call cost is what the gateway reports back.
 */
const glm = (id: string, name: string, rates: Rates) => ({
  id,
  name,
  api: 'openai-completions' as const,
  provider: 'explabs',
  baseUrl,
  reasoning: true,
  input: ['text' as const, 'image' as const],
  cost: { ...rates, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
})

/** The model Vivid answers with when `VIVID_MODEL` names none. */
export const DEFAULT_MODEL = 'explabs/glm-5.3-flash'

const completions = openAICompletionsApi()

/**
 * Pi 0.87.1 openai-completions retries only create(...).withResponse(), before emitting start
 * or consuming the stream. Its public options cover 5xx (including 520–524) and connection
 * failures; defaults are zero retries. Keep two retries and cap server-requested waits at 2 s.
 * Flue 2.2.2 useModel has no request options, so supply these at its public Provider API seam.
 * No stream is replayed here: a failure after assistant content or a tool delta stays failed.
 */
const requestBudget = { maxRetries: 2, maxRetryDelayMs: 2_000 }
const requests: ProviderStreams = {
  stream: (model, context, options) =>
    completions.stream(model, context, { ...options, ...requestBudget }),
  streamSimple: (model, context, options) =>
    completions.streamSimple(model, context, { ...options, ...requestBudget }),
}

/** The same production provider is exercised through its public streaming seam in tests. */
export const provider = createProvider({
  id: 'explabs',
  name: 'Experiential Labs',
  baseUrl,
  auth: { apiKey: envApiKeyAuth('Experiential Labs API key', ['EXPLABS_API_KEY']) },
  models: [
    // Free on the gateway's promotional tier. On 3 Oct 2026 it was listed but did not answer:
    // a plain request hung for two minutes with no bytes, so it is declared and not the default.
    glm('glm-5.3-flash-abliterated', 'GLM 5.3 Flash (abliterated)', {
      input: 0,
      output: 0,
      cacheRead: 0,
    }),
    glm('glm-5.3-flash', 'GLM 5.3 Flash', { input: 0.075, output: 0.25, cacheRead: 0.015 }),
  ],
  api: requests,
})

setProvider(provider)
