import type { TSchema } from '@earendil-works/pi-ai'
import { defineExtension, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { asSchema, type Tool, type ToolSet } from 'ai'

/** Whether an interrupted call may run again after a crash. Pi Durable's own default is `unsafe`. */
export type Replay = 'safe' | 'unsafe'

export type ToolsOptions = {
  /**
   * Tools that may rerun after a crash, by name. An AI SDK tool has no such declaration, and
   * rerunning a tool with a side effect is the dangerous default, so every tool not named here is
   * `unsafe`: after a crash the model is told the call was interrupted.
   */
  readonly replay?: Readonly<Record<string, Replay>>
}

/** What the model reads as the tool's result. A string stays as written; anything else is JSON. */
const resultText = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output))

/**
 * One AI SDK tool as a Pi Durable tool.
 *
 * The JSON Schema the AI SDK derives from the input schema (Zod, Valibot, any Standard Schema) is
 * what Pi Durable shows the model and validates against. The tool's own validator then runs too,
 * because it may transform the value (defaults, coercion) and the tool is typed by its output.
 */
async function registration(name: string, tool: Tool, replay: Replay): Promise<ToolRegistration> {
  const schema = asSchema(tool.inputSchema)
  const parameters = (await schema.jsonSchema) as TSchema
  const execute = tool.execute
  return {
    name,
    // AI SDK 7 allows a description computed from a context; this bridge has no context to give.
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters,
    replay,
    execute: async (args) => {
      if (execute === undefined) {
        return { isError: true, content: [{ type: 'text', text: `Tool ${name} has no server execute` }] }
      }
      const checked = schema.validate === undefined ? { success: true as const, value: args } : await schema.validate(args)
      if (!checked.success) {
        return { isError: true, content: [{ type: 'text', text: checked.error.message }] }
      }
      // Gap: a Chord context carries cancellation, but no AbortSignal is derived from it yet, and
      // the tool does not receive the transcript as `messages`.
      const output: unknown = await execute(checked.value, {
        toolCallId: name,
        messages: [],
        context: undefined,
      })
      return { content: [{ type: 'text', text: resultText(output) }] }
    },
  }
}

/**
 * A set of AI SDK tools as one Pi Durable extension, to install in a registry.
 *
 * Async because a schema library may build its JSON Schema lazily.
 */
export async function toolsExtension(name: string, tools: ToolSet, options: ToolsOptions = {}): Promise<Extension> {
  const registrations = await Promise.all(
    Object.entries(tools).map(([toolName, tool]) =>
      registration(toolName, tool, options.replay?.[toolName] ?? 'unsafe'),
    ),
  )
  return defineExtension({ name, tools: registrations })
}
