import type { JsonValue } from '@earendil-works/chord'
import type { TSchema } from '@earendil-works/pi-ai'
import {
  defineExtension,
  type Extension,
  hook,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { asSchema, type Tool, type ToolSet } from 'ai'

import { holdKind, Holds, type Plan, settlement, type Source, withPlan } from './holds.ts'

/** Whether an interrupted call may run again after a crash. Pi Durable's own default is `unsafe`. */
export type Replay = 'safe' | 'unsafe'

export type ToolsOptions = {
  /**
   * Tools that may rerun after a crash, by name. An AI SDK tool has no such declaration, and
   * rerunning a tool with a side effect is the dangerous default, so every tool not named here is
   * `unsafe`: after a crash the model is told the call was interrupted.
   */
  readonly replay?: Readonly<Record<string, Replay>>
  /**
   * Tools whose calls wait for a person's approval, by name: `true` for every call, or a test on
   * the call's input. The same shape as the AI SDK's per-tool `toolApproval`, without the automatic
   * statuses. The test runs more than once per call, so it must be pure.
   */
  readonly approval?: Readonly<Record<string, boolean | ((input: unknown) => boolean)>>
  /**
   * For tools with no `execute`, whose result a person supplies: `wait` keeps the model inside the
   * call until the answer arrives (the AI SDK's client-side tool), `later` returns at once and
   * delivers the answer as a new message. Default `wait`.
   */
  readonly answers?: Readonly<Record<string, 'wait' | 'later'>>
}

/** What the model reads as the tool's result. A string stays as written; anything else is JSON. */
const resultText = (output: unknown) =>
  typeof output === 'string' ? output : JSON.stringify(output)

/**
 * A tool's output as the JSON Pi Durable stores. `undefined` (a tool that returns nothing) and
 * values JSON cannot carry become what `JSON.stringify` makes of them, or `null`.
 */
function toJson(output: unknown): JsonValue {
  const text = JSON.stringify(output)
  return text === undefined ? null : (JSON.parse(text) as JsonValue)
}

/**
 * A result with the tool's own output kept beside the text the model reads. The stream gives that
 * output to AI SDK clients as the tool part's `output`, as `streamText` would.
 */
const result = (output: unknown): ToolExecutionResult => ({
  content: [{ type: 'text', text: resultText(output) }],
  details: { output: toJson(output) },
})

const failure = (text: string): ToolExecutionResult => ({
  isError: true,
  content: [{ type: 'text', text }],
})

type Execute = ToolRegistration['execute']

/**
 * Run the tool's own `execute`.
 *
 * Pi Durable has already validated the arguments against the JSON Schema. The tool's own validator
 * runs too, because it may transform the value (defaults, coercion) and the tool is typed by its
 * output.
 */
function serverExecute(tool: Tool, execute: NonNullable<Tool['execute']>): Execute {
  const schema = asSchema(tool.inputSchema)
  return async (args, api, context) => {
    const checked =
      schema.validate === undefined
        ? { success: true as const, value: args }
        : await schema.validate(args)
    if (!checked.success) return failure(checked.error.message)
    // Gap: the tool does not receive the transcript as `messages`.
    const output: unknown = await execute(checked.value, {
      toolCallId: api.callId,
      messages: [],
      abortSignal: context.abortSignal,
      context: undefined,
    })
    return result(output)
  }
}

/** The call waited in the hook until a person answered; hand that answer to the model. */
const waitExecute =
  (name: string): Execute =>
  async (_args, api, context) => {
    const settled = (await api.snapshot(Holds, api.conversationId, context))?.settled[api.callId]
    return settled?.kind === 'answered'
      ? result(settled.output)
      : failure(`Tool ${name} was not answered`)
  }

/**
 * Record the question and return at once. The answer arrives later as a user message, so the
 * model is told to carry on rather than to wait.
 */
const laterExecute =
  (name: string): Execute =>
  async (_args, api, context) => {
    await api.commit(async (tx) => {
      ;(await tx.doc(Holds, api.conversationId)).asked[api.callId] = name
    }, context)
    return result({
      status: 'asked',
      note: 'The answer will arrive later as a new message. Continue with other work.',
    })
  }

/** How one tool is bridged: its plan, its replay policy, and the `execute` Pi Durable calls. */
type Bridged = { readonly plan: Plan; readonly replay: Replay; readonly execute: Execute }

function bridge(name: string, tool: Tool, options: ToolsOptions): Bridged {
  const rule = options.approval?.[name] ?? false
  const approval = typeof rule === 'function' ? rule : () => rule
  if (tool.execute !== undefined) {
    const plan = { approval, source: 'server' as Source }
    return {
      plan,
      replay: options.replay?.[name] ?? 'unsafe',
      execute: serverExecute(tool, tool.execute),
    }
  }
  // Both person-answered forms only read or write the hold document, so rerunning them is safe.
  const source = options.answers?.[name] ?? 'wait'
  const execute = source === 'later' ? laterExecute(name) : waitExecute(name)
  return { plan: { approval: () => false, source }, replay: 'safe', execute }
}

/**
 * One AI SDK tool as a Pi Durable tool.
 *
 * The JSON Schema the AI SDK derives from the input schema (Zod, Valibot, any Standard Schema) is
 * what Pi Durable shows the model and validates against.
 */
async function registration(name: string, tool: Tool, bridged: Bridged): Promise<ToolRegistration> {
  const parameters = (await asSchema(tool.inputSchema).jsonSchema) as TSchema
  return withPlan(
    {
      name,
      // AI SDK 7 allows a description computed from a context; this bridge has no context to give.
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters,
      replay: bridged.replay,
      execute: bridged.execute,
    },
    bridged.plan,
  )
}

/**
 * A set of AI SDK tools as one Pi Durable extension, to install in a registry.
 *
 * The extension also carries the hook that makes approvals and person-answered tools wait: it runs
 * before Pi Durable records a call's intent, which is the only point where a wait survives a
 * restart without the call being reported as interrupted.
 *
 * Async because a schema library may build its JSON Schema lazily.
 */
export async function toolsExtension(
  name: string,
  tools: ToolSet,
  options: ToolsOptions = {},
): Promise<Extension> {
  const bridged = Object.entries(tools).map(([toolName, tool]) => ({
    toolName,
    tool,
    bridged: bridge(toolName, tool, options),
  }))
  const registrations = await Promise.all(
    bridged.map((each) => registration(each.toolName, each.tool, each.bridged)),
  )
  const plans = new Map(bridged.map((each) => [each.toolName, each.bridged.plan]))
  const waits = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const plan = plans.get(call.name)
      if (plan === undefined || holdKind(plan, call.arguments) === undefined) return undefined
      const settled = await settlement(api, call.id, context)
      return settled.kind === 'denied' ? { block: settled.reason } : undefined
    },
  })
  return defineExtension({ name, tools: registrations, hooks: [waits] })
}
