import { defineTool, type ToolDefinition } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import type { ConnectionId } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as v from 'valibot'
import { runServerRpc } from '../client.ts'

/** The JSON-schema subset Flue needs to render and validate Connection tool inputs. */
interface ConnectionToolParameters {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ConnectionToolProperty>>
  readonly required?: ReadonlyArray<string>
}

interface ConnectionToolProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean'
  readonly description?: string
}

interface RuntimeConnectionTool {
  readonly connector: ConnectionId
  readonly name: string
  readonly description: string
  readonly parameters: ConnectionToolParameters
}

const decodeConnectorToolInput = Schema.decodeUnknownEffect(Schema.Json)

/** Builds the model-facing tool that sends its validated input to the server RPC boundary. */
const wrapConnectionTool = (tool: RuntimeConnectionTool): ToolDefinition =>
  defineTool({
    name: tool.name,
    description: tool.description,
    input: buildInputSchema(tool.parameters),
    async run(context) {
      const input = await Effect.runPromise(decodeConnectorToolInput(context.data))
      const response = await Effect.runPromise(
        runServerRpc(
          Effect.gen(function* () {
            const client = yield* VividRpcClient
            return yield* client.ExecuteConnectionTool({
              connector: tool.connector,
              tool: tool.name,
              input,
            })
          }),
        ),
      )
      return { output: response.output }
    },
  })

type PrimitiveToolSchema =
  | v.StringSchema<undefined>
  | v.NumberSchema<undefined>
  | v.BooleanSchema<undefined>
type ToolFieldSchema = PrimitiveToolSchema | v.OptionalSchema<PrimitiveToolSchema, undefined>

const toValibotType = (type: 'string' | 'number' | 'integer' | 'boolean'): PrimitiveToolSchema => {
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

/** Converts the server-owned descriptor into the runtime's current Valibot input contract. */
function buildInputSchema(parameters: ConnectionToolParameters) {
  const required = parameters.required ?? []
  const entries: Record<string, ToolFieldSchema> = {}
  for (const [key, property] of Object.entries(parameters.properties)) {
    const base = toValibotType(property.type)
    entries[key] = required.includes(key) ? base : v.optional(base)
  }
  return v.looseObject(entries)
}

const gmailTools: ReadonlyArray<RuntimeConnectionTool> = [
  {
    connector: 'gmail',
    name: 'gmail_list_messages',
    description: 'List recent emails from Gmail. Returns subject, sender, date, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Gmail search query (e.g., 'is:unread')" },
        maxResults: {
          type: 'number',
          description: 'Maximum number of messages to return (default 10)',
        },
      },
    },
  },
  {
    connector: 'gmail',
    name: 'gmail_send_email',
    description: 'Send an email via Gmail.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    connector: 'gmail',
    name: 'gmail_search',
    description: 'Search emails with a Gmail query and return full details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        maxResults: { type: 'number', description: 'Maximum results (default 5)' },
      },
      required: ['query'],
    },
  },
]

const calendarTools: ReadonlyArray<RuntimeConnectionTool> = [
  {
    connector: 'calendar',
    name: 'calendar_list_events',
    description: 'List upcoming calendar events from Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'Start of time range (ISO 8601, default: now)' },
        timeMax: {
          type: 'string',
          description: 'End of time range (ISO 8601, default: 7 days from now)',
        },
        maxResults: { type: 'number', description: 'Maximum events to return (default 10)' },
      },
    },
  },
  {
    connector: 'calendar',
    name: 'calendar_create_event',
    description: 'Create a new event on Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    connector: 'calendar',
    name: 'calendar_delete_event',
    description: 'Delete an event from Google Calendar.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'The event ID to delete' } },
      required: ['eventId'],
    },
  },
]

const driveTools: ReadonlyArray<RuntimeConnectionTool> = [
  {
    connector: 'drive',
    name: 'drive_search',
    description: 'Search for files in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Google Drive search query' },
        maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    connector: 'drive',
    name: 'drive_read_file',
    description: 'Read the content of a text file from Google Drive.',
    parameters: {
      type: 'object',
      properties: { fileId: { type: 'string', description: 'The Google Drive file ID' } },
      required: ['fileId'],
    },
  },
  {
    connector: 'drive',
    name: 'drive_list_recent',
    description: 'List recently modified files in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
      },
    },
  },
]

const toolsFor = (tools: ReadonlyArray<RuntimeConnectionTool>) => tools.map(wrapConnectionTool)

/** Exposes the Gmail action descriptors while execution remains on the application server. */
export function gmailConnectorTools() {
  return toolsFor(gmailTools)
}

/** Exposes the Calendar action descriptors while execution remains on the application server. */
export function calendarConnectorTools() {
  return toolsFor(calendarTools)
}

/** Exposes the Drive action descriptors while execution remains on the application server. */
export function driveConnectorTools() {
  return toolsFor(driveTools)
}

/** Reads Connection state through RPC and displays the result in the inline suggestion card. */
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
    return { output: { kind: 'connector-request', ...data, status } }
  },
})
