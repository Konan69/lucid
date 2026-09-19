import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { setProvider } from "@flue/runtime";

const builtIn = openrouterProvider();
const glm53Flash = {
  id: "z-ai/glm-5.3-flash",
  name: "Z.ai: GLM 5.3 Flash",
  api: "openai-completions" as const,
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text", "image"] satisfies ("text" | "image")[],
  cost: {
    input: 0.075,
    output: 0.25,
    cacheRead: 0.015,
    cacheWrite: 0,
  },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
};

setProvider({
  ...builtIn,
  getModels: () => [
    ...builtIn.getModels().filter((model) => model.id !== glm53Flash.id),
    glm53Flash,
  ],
});
