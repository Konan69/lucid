import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import {
  gmailTools,
  calendarTools,
  driveTools,
} from "@konan/connectors";

type ConnectorTool = {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => unknown;
};

const flexibleInput = v.looseObject({}) as v.GenericSchema<Record<string, unknown>, unknown>;

function wrapConnectorTool(tool: ConnectorTool): ToolDefinition {
  const definition = {
    name: tool.name,
    description: tool.description,
    input: flexibleInput,
    async run(context: { data: unknown }) {
      const output = await tool.execute((context.data ?? {}) as Record<string, unknown>);
      return { output };
    },
  };
  return defineTool(definition) as ToolDefinition;
}

export function gmailConnectorTools() {
  const tools = gmailTools();
  if (tools.length === 0) return [];
  return tools.map((tool) => wrapConnectorTool(tool as ConnectorTool));
}

export function calendarConnectorTools() {
  const tools = calendarTools();
  if (tools.length === 0) return [];
  return tools.map((tool) => wrapConnectorTool(tool as ConnectorTool));
}

export function driveConnectorTools() {
  const tools = driveTools();
  if (tools.length === 0) return [];
  return tools.map((tool) => wrapConnectorTool(tool as ConnectorTool));
}
