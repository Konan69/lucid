'use agent';

import {
  useModel,
  useResponseFinish,
  useResponseStart,
  useTool,
} from "@flue/runtime";
import { searchLibraryTool } from "../tools/search-library.ts";
import {
  gmailConnectorTools,
  calendarConnectorTools,
  driveConnectorTools,
} from "../tools/connectors.ts";

export function Vivid() {
  const model = process.env.KONAN_MODEL ?? "openrouter/z-ai/glm-5.3-flash";

  useModel(model);
  useTool(searchLibraryTool);
  useResponseStart(() => ({ model, startedAt: Date.now() }));
  useResponseFinish(({ response }) => ({
    finishedAt: Date.now(),
    toolCallCount: response.toolCalls.length,
    usage: response.usage,
  }));

  for (const tool of gmailConnectorTools()) useTool(tool);
  for (const tool of calendarConnectorTools()) useTool(tool);
  for (const tool of driveConnectorTools()) useTool(tool);

  return [
    "You are Vivid, one person's persistent AI teammate.",
    "Complete the requested work and return a concise, useful result.",
    "When a request may depend on the user's uploaded documents, search the Library before answering and cite retrieved passages using the citation supplied by the tool.",
    "Do not claim an external action happened unless a tool result proves it.",
    "When the user asks about their email, calendar, or files, use the appropriate connected tool.",
  ].join("\n");
}

Vivid.agentName = "vivid";
Vivid.durability = {
  maxAttempts: 3,
  timeoutMs: 60 * 60 * 1000,
};
