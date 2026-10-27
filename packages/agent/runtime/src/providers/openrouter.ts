import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { witnessed } from './budget.ts'

/**
 * OpenRouter, which speaks OpenAI's Chat Completions and routes the same GLM 5.3 Flash Vivid
 * answers with elsewhere. Declared on 20 October 2026, when the Experiential Labs organization ran
 * out of credits (`429 insufficient_credits`) and the OpenCode Go key expired
 * (`401 api_key_expired`), so production Vivid could not answer at all. One base address, one key
 * (`OPENROUTER_API_KEY`), and the model named by OpenRouter's own id, which itself holds a slash:
 * `VIVID_MODEL` is `openrouter/z-ai/glm-5.3-flash` (the model catalog splits a specifier at its first slash).
 *
 * A model Vivid may be pointed at is declared below with the limits Pi needs to run it. To use
 * another of OpenRouter's models, add it here with its id exactly as `GET /v1/models` returns it.
 */
const baseUrl = 'https://openrouter.ai/api/v1'

/**
 * One OpenRouter model, with the context window and output limit OpenRouter's catalogue gives it
 * and the upstreams to try first. Cost is left to OpenRouter's own accounting; Pi's reads zero.
 *
 * `HTTP-Referer` and `X-Title` are how OpenRouter asks an application to name itself. OpenRouter
 * otherwise picks the upstream per request, and the slowest of them spend ten times as long on
 * the same turn; the fallbacks stay allowed so Vivid still answers when the first is down.
 */
const model = (
  id: string,
  name: string,
  limits: { readonly contextWindow: number; readonly maxTokens: number },
  order: ReadonlyArray<string>,
) => ({
  id,
  name,
  api: 'openai-completions' as const,
  provider: 'openrouter',
  baseUrl,
  reasoning: true,
  input: ['text' as const, 'image' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...limits,
  headers: { 'HTTP-Referer': 'https://vivid.app', 'X-Title': 'Vivid' },
  compat: { openRouterRouting: { order: [...order], allow_fallbacks: true } },
})

/**
 * GLM 5.3 Flash. On 21 October 2026 OpenRouter sent Vivid's ~23k-token turns to OpenInference,
 * which spent 9.9 to 18.8 s generating 100 to 600 tokens per model step; Together served the same
 * model and prompt in 0.5 to 1.8 s (`generation_time` in OpenRouter's generation records).
 */
const glm = model(
  'z-ai/glm-5.3-flash',
  'GLM 5.3 Flash',
  { contextWindow: 1_048_576, maxTokens: 131_072 },
  ['together'],
)

/**
 * DeepSeek V4.1 Flash (the 17 October 2026 snapshot), the newest DeepSeek on OpenRouter on
 * 26 October 2026. Measured that day with a streamed tool-calling turn, three runs each: Together
 * answered first in 0.75 to 1.1 s (one run 3.2 s) and Fireworks in 0.9 to 1.2 s, against 1.0 to
 * 11.9 s on DeepInfra and up to 4.6 s on Cloudflare; DeepSeek's own endpoint returned 404.
 */
const deepseek = model(
  'deepseek/deepseek-v4.1-flash-1017',
  'DeepSeek V4.1 Flash',
  { contextWindow: 1_048_576, maxTokens: 393_216 },
  ['together', 'fireworks'],
)

/** The same production provider is exercised through its public streaming seam in tests. */
export const provider = createProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl,
  auth: { apiKey: envApiKeyAuth('OpenRouter API key', ['OPENROUTER_API_KEY']) },
  models: [glm, deepseek],
  api: witnessed,
})
