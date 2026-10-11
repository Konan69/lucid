import { createProvider, envApiKeyAuth, type ProviderStreams } from '@earendil-works/pi-ai'
import { setProvider } from '@flue/runtime'
import { completions, requestBudget } from './budget.ts'

/**
 * Vivid's model provider: OpenCode Go, the subscription gateway to open models
 * (https://opencode.ai/docs/go/). Its GLM, Kimi, DeepSeek and MiMo models speak OpenAI's Chat
 * Completions at one base address with one key (`OPENCODE_API_KEY`, the name Pi 0.87.1 itself
 * reads for `opencode-go` in `env-api-keys.js`), so `VIVID_MODEL` is `opencode-go/<id>`.
 *
 * It replaced the Experiential Labs gateway as the default on 11 October 2026. That evening the
 * old gateway answered the same request with `400 invalid_request` four times in ten, each after
 * ten seconds, and a Person got no reply; OpenCode Go answered that request eight times in eight.
 * `explabs.ts` stays declared, so `VIVID_MODEL` can still name a model there.
 *
 * A model Vivid may be pointed at is declared below with the limits Pi needs to run it. To use
 * another of Go's Chat Completions models, add it here with its id exactly as `GET /v1/models`
 * returns it. Go's Claude, MiniMax and Qwen models speak Anthropic's Messages and its GPT and
 * Grok models OpenAI's Responses; those need their own `api` and are not declared.
 */
const baseUrl = 'https://opencode.ai/zen/go/v1'

/**
 * GLM 5.3 Flash, with the context window and output limit the model has on every gateway. Go is
 * a subscription with usage limits, and its catalogue (`GET /v1/models`) lists no price, so Pi's
 * own cost accounting reads zero here; what was used is on the OpenCode console.
 *
 * `User-Agent`: Go asks a client to identify itself with its own user agent.
 */
const glm = (id: string, name: string) => ({
  id,
  name,
  api: 'openai-completions' as const,
  provider: 'opencode-go',
  baseUrl,
  reasoning: true,
  input: ['text' as const, 'image' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
  headers: { 'User-Agent': 'vivid-runtime' },
})

/** The model Vivid answers with when `VIVID_MODEL` names none. */
export const DEFAULT_MODEL = 'opencode-go/glm-5.3-flash'

/**
 * Go asks for a stable session id in `x-opencode-session` (opencode sends its own session id:
 * `refs/opencode/packages/opencode/src/session/llm/request.ts`). Pi hands a provider the id of
 * the session a request belongs to; a request made outside one carries no such header.
 */
const sessionHeader = (sessionId: string | undefined): Record<string, string> =>
  sessionId === undefined ? {} : { 'x-opencode-session': sessionId }

/** The shared request budget (`budget.ts`), and the session a request belongs to. */
const requests: ProviderStreams = {
  stream: (model, context, options) =>
    completions.stream(model, context, {
      ...options,
      ...requestBudget,
      headers: { ...options?.headers, ...sessionHeader(options?.sessionId) },
    }),
  streamSimple: (model, context, options) =>
    completions.streamSimple(model, context, {
      ...options,
      ...requestBudget,
      headers: { ...options?.headers, ...sessionHeader(options?.sessionId) },
    }),
}

/** The same production provider is exercised through its public streaming seam in tests. */
export const provider = createProvider({
  id: 'opencode-go',
  name: 'OpenCode Go',
  baseUrl,
  auth: { apiKey: envApiKeyAuth('OpenCode Go API key', ['OPENCODE_API_KEY']) },
  models: [glm('glm-5.3-flash', 'GLM 5.3 Flash'), glm('glm-5.3', 'GLM 5.3')],
  api: requests,
})

setProvider(provider)
