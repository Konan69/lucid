import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { setProvider } from '@flue/runtime'
import { budgeted } from './budget.ts'

/**
 * The Experiential Labs gateway, which speaks OpenAI's Chat Completions. It was Vivid's default
 * until 11 October 2026 (`opencode.ts` says why) and stays declared so `VIVID_MODEL` can name a
 * model here: one base address, one key (`EXPLABS_API_KEY`), and a model named by the gateway's
 * own id, so `VIVID_MODEL` is `explabs/<id>`. Pi retries request establishment before streaming;
 * the gateway owns failover between upstream providers. The shared seam witnesses refusals;
 * Pi alone decides whether to retry them, as it does for OpenCode Go.
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
  api: budgeted,
})

setProvider(provider)
