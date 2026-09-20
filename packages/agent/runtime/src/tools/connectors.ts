import { defineTool, type ToolDefinition } from '@flue/runtime'
import type { BoundConnectorTool, ConnectorToolParameters } from '@vivid/connectors'
import { gmailTools, calendarTools, driveTools } from '@vivid/connectors'
import { VividRpcClient } from '@vivid/client-runtime'
import { Effect, Schema } from 'effect'
import { runServerRpc } from '../client.ts'
import * as v from 'valibot'

const decodeConnectorToolInput = Schema.decodeUnknownEffect(Schema.Json)

export const suggestConnectorTool = defineTool({
  name: 'suggest_connector',
  description:
    "Offer a connector in this conversation when it is needed for the user's request. Shows an inline card with your reason and a Connect button; it does not authorize access. Only suggest the service needed now. Returns its actual status. If connected, use its tools instead of asking to connect again; otherwise wait for the user to authorize and continue.",
  input: v.object({
    connector: v.picklist(['gmail', 'calendar', 'drive']),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  }),
  async run({ data }) {
    const response = await Effect.runPromise(
      runServerRpc(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          return yield* client.ListConnections()
        }),
      ),
    )
    const connection = response.connectors.find((item) => item.id === data.connector)
    const status = connection === undefined ? 'disconnected' : connection.status
    return {
      output: {
        kind: 'connector-request',
        ...data,
        status,
      },
    }
  },
})

type PrimitiveToolSchema =
  | v.StringSchema<undefined>
  | v.NumberSchema<undefined>
  | v.BooleanSchema<undefined>
type ToolFieldSchema = PrimitiveToolSchema | v.OptionalSchema<PrimitiveToolSchema, undefined>

function toValibotType(type: 'string' | 'number' | 'integer' | 'boolean'): PrimitiveToolSchema {
  switch (type) {
    case 'string':
      return v.string()
    case 'number':
    case 'integer':
      return v.number()
    case 'boolean':
      return v.boolean()
  }
  return type
}

function buildInputSchema(parameters: ConnectorToolParameters) {
  const required = parameters.required ?? []
  const entries: Record<string, ToolFieldSchema> = {}

  for (const [key, prop] of Object.entries(parameters.properties)) {
    const base = toValibotType(prop.type)
    entries[key] = required.includes(key) ? base : v.optional(base)
  }

  return v.looseObject(entries)
}

function wrapConnectorTool(tool: BoundConnectorTool): ToolDefinition {
  return defineTool({
    name: tool.name,
    description: tool.description,
    input: buildInputSchema(tool.parameters),
    async run(context) {
      // Flue decodes the declared Valibot shape before invoking this callback; this boundary
      // confirms JSON transport values, and execute decodes the connector's concrete schema once.
      const output = await Effect.runPromise(
        decodeConnectorToolInput(context.data).pipe(Effect.flatMap((input) => tool.execute(input))),
      )
      return { output }
    },
  })
}

export function gmailConnectorTools() {
  const tools = gmailTools()
  if (tools.length === 0) return []
  return tools.map((tool) => wrapConnectorTool(tool))
}

export function calendarConnectorTools() {
  const tools = calendarTools()
  if (tools.length === 0) return []
  return tools.map((tool) => wrapConnectorTool(tool))
}

export function driveConnectorTools() {
  const tools = driveTools()
  if (tools.length === 0) return []
  return tools.map((tool) => wrapConnectorTool(tool))
}
