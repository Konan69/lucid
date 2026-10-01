import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { setProvider } from '@flue/runtime'
import { modelStream } from './policy.ts'
import { Stream } from 'effect'
import { ModelName, ModelUnavailable } from './failure.ts'
import { ModelStream } from './stream.ts'

const builtIn = openrouterProvider()
const glm53Flash = {
  id: 'z-ai/glm-5.3-flash',
  name: 'Z.ai: GLM 5.3 Flash',
  api: 'openai-completions' as const,
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true,
  input: ['text', 'image'] satisfies ('text' | 'image')[],
  cost: {
    input: 0.075,
    output: 0.25,
    cacheRead: 0.015,
    cacheWrite: 0,
  },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
}

const provider = {
  ...builtIn,
  getModels: () => [
    ...builtIn.getModels().filter((model) => model.id !== glm53Flash.id),
    glm53Flash,
  ],
}

// Flue's public registration seam keeps model policy outside its history and lifecycle internals.
setProvider({
  ...provider,
  /** Registration accepts any API model; catalog lookup proves this provider's completion API. */
  streamSimple: (model, context, options) => {
    const resolved = provider.getModels().find((candidate) => candidate.id === model.id)
    const events =
      resolved === undefined
        ? Stream.fail(new ModelUnavailable({ model: ModelName.make(model.id), transient: false }))
        : modelStream(provider, resolved, context, options === undefined ? {} : options)
    return new ModelStream(events)
  },
})
