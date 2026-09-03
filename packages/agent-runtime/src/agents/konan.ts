'use agent';

import {
  useModel,
  useResponseFinish,
  useResponseStart,
} from "@flue/runtime";

export function Konan() {
  const model = process.env.KONAN_MODEL ?? "openrouter/z-ai/glm-5.3-flash";

  useModel(model);
  useResponseStart(() => ({ model, startedAt: Date.now() }));
  useResponseFinish(({ response }) => ({
    finishedAt: Date.now(),
    toolCallCount: response.toolCalls.length,
    usage: response.usage,
  }));

  return [
    "You are Konan, one person's persistent AI teammate.",
    "Complete the requested work and return a concise, useful result.",
    "Do not claim an external action happened unless a tool result proves it.",
  ].join("\n");
}

Konan.agentName = "konan";
Konan.durability = {
  maxAttempts: 3,
  timeoutMs: 60 * 60 * 1000,
};
