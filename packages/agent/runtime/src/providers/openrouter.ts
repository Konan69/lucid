import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { setProvider } from '@flue/runtime'
import { budgeted } from './budget.ts'

/**
 * OpenRouter, which speaks OpenAI's Chat Completions and routes the same GLM 5.3 Flash Vivid
 * answers with elsewhere. Declared on 20 October 2026, when the Experiential Labs organization ran
 * out of credits (`429 insufficient_credits`) and the OpenCode Go key expired
 * (`401 api_key_expired`), so production Vivid could not answer at all. One base address, one key
 * (`OPENROUTER_API_KEY`), and the model named by OpenRouter's own id, which itself holds a slash:
 * `VIVID_MODEL` is `openrouter/z-ai/glm-5.3-flash` (Flue splits a specifier at its first slash).
 *
 * A model Vivid may be pointed at is declared below with the limits Pi needs to run it. To use
 * another of OpenRouter's models, add it here with its id exactly as `GET /v1/models` returns it.
 */
const baseUrl = 'https://openrouter.ai/api/v1'

/**
 * GLM 5.3 Flash, with the context window and output limit the model has on every gateway. Cost is
 * left to OpenRouter's own accounting; Pi's reads zero here.
 *
 * `HTTP-Referer` and `X-Title` are how OpenRouter asks an application to name itself.
 */
const glm = (id: string, name: string) => ({
  id,
  name,
  api: 'openai-completions' as const,
  provider: 'openrouter',
  baseUrl,
  reasoning: true,
  input: ['text' as const, 'image' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
  headers: { 'HTTP-Referer': 'https://vivid.app', 'X-Title': 'Vivid' },
})

/** The same production provider is exercised through its public streaming seam in tests. */
export const provider = createProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl,
  auth: { apiKey: envApiKeyAuth('OpenRouter API key', ['OPENROUTER_API_KEY']) },
  models: [glm('z-ai/glm-5.3-flash', 'GLM 5.3 Flash')],
  api: budgeted,
})

setProvider(provider)
