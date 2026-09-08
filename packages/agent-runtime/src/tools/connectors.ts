import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { gmailTools, calendarTools, driveTools, getConnectorStatus } from "@vivid/connectors";

export const suggestConnectorTool = defineTool({
  name: "suggest_connector",
  description: "Offer a connector in this conversation when it is needed for the user's request. Shows an inline card with your reason and a Connect button; it does not authorize access. Only suggest the service needed now. Returns its actual status. If connected, use its tools instead of asking to connect again; otherwise wait for the user to authorize and continue.",
  input: v.object({
    connector: v.picklist(["gmail", "calendar", "drive"]),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  }),
  async run({ data }) {
    return { output: { kind: "connector-request", ...data, status: await getConnectorStatus(data.connector) } };
  }
});

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, { type?: string | string[]; description?: string }>;
  required?: string[];
};

type ConnectorTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => unknown;
};

function toValibotType(type: string | string[] | undefined): v.GenericSchema<unknown, unknown> {
  const t = Array.isArray(type) ? type[0] : type;
  switch (t) {
    case "string":
      return v.string() as v.GenericSchema<unknown, unknown>;
    case "number":
    case "integer":
      return v.number() as v.GenericSchema<unknown, unknown>;
    case "boolean":
      return v.boolean() as v.GenericSchema<unknown, unknown>;
    default:
      return v.unknown() as v.GenericSchema<unknown, unknown>;
  }
}

function buildInputSchema(parameters: Record<string, unknown>): v.GenericSchema<Record<string, unknown>, unknown> {
  const schema = (parameters ?? {}) as JsonSchema;
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const entries: Record<string, v.GenericSchema<unknown, unknown>> = {};

  for (const [key, prop] of Object.entries(props)) {
    const base = toValibotType(prop.type);
    const field = required.includes(key) ? base : v.optional(base) as v.GenericSchema<unknown, unknown>;
    entries[key] = field;
  }

  const objectSchema = v.looseObject(entries) as unknown;
  return objectSchema as v.GenericSchema<Record<string, unknown>, unknown>;
}

function wrapConnectorTool(tool: ConnectorTool): ToolDefinition {
  const definition = {
    name: tool.name,
    description: tool.description,
    input: buildInputSchema(tool.parameters),
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
