import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  defineExtension,
  hook,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { asSchema, type Tool, type ToolSet } from 'ai'
import { Effect, Option, Predicate, Schema } from 'effect'

import { ToolFailed, ToolOutputFailed, ToolSchemaFailed } from './errors.ts'
import { holdKind, Holds, type Plan, settlement, withPlan } from './holds.ts'
import * as Pi from './pi.ts'

/** Whether an interrupted call may run again after a crash. Pi's own default is unsafe. */
export type Replay = 'safe' | 'unsafe'

export type ToolsOptions = {
  /** Only explicitly named server tools may rerun after a crash; the default protects side effects. */
  readonly replay?: Readonly<Record<string, Replay>>
  /** Pure predicates see Pi-validated JSON arguments before the SDK applies transformations. */
  readonly approval?: Readonly<Record<string, boolean | ((input: JsonValue) => boolean)>>
  /** Tools without execute wait inside the call by default; later delivers an answer as new input. */
  readonly answers?: Readonly<Record<string, 'wait' | 'later'>>
}

type Lookups = {
  readonly replay: NonNullable<ToolsOptions['replay']>
  readonly approval: NonNullable<ToolsOptions['approval']>
  readonly answers: NonNullable<ToolsOptions['answers']>
}

type Execute = ToolRegistration['execute']
type Program = (
  args: Parameters<Execute>[0],
  api: ToolExecutionApi,
  context: Context,
) => Effect.Effect<
  ToolExecutionResult,
  ToolFailed | ToolOutputFailed | import('./errors.ts').PiFailed
>

const decodeText = Schema.decodeUnknownEffect(Schema.String)
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.MutableJson))

/** The SDK result's serialized text and JSON envelope are validated at its unsafe boundary. */
type Output = { readonly text: string; readonly output: JsonValue }

/** A bridged result preserves the tool's JSON output beside the text the model reads. */
const result = (output: Output): ToolExecutionResult => ({
  content: [{ type: 'text', text: output.text }],
  details: { output: output.output },
})

/** Validation and missing answers are existing tool-error values, rather than infrastructure failures. */
const failure = (text: string): ToolExecutionResult => ({
  isError: true,
  content: [{ type: 'text', text }],
})

/** Every execute callback runs exactly one Effect through the single Pi runtime ingress. */
function executeForPi(program: Program): Execute {
  return function execute(args, api, context) {
    return Pi.runForPi(program(args, api, context), context.abortSignal)
  }
}

type Server = {
  readonly name: string
  readonly schema: ReturnType<typeof asSchema>
  readonly execute: NonNullable<Tool['execute']>
}

/** SDK validators may be synchronous or Promise-based; normalize only this external operation. */
const validate = (server: Server, args: Parameters<Execute>[0]) => {
  const schema = server.schema
  if (schema.validate === undefined) return Effect.succeed({ success: true as const, value: args })
  return Effect.tryPromise({
    try: async () =>
      schema.validate === undefined
        ? { success: true as const, value: args }
        : schema.validate(args),
    catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
  })
}

/**
 * The SDK's execute result is untyped at this third-party ingress. Serialize here, then decode the
 * actual persisted JSON once. Void returns retain the existing null output representation.
 */
const invoke = Effect.fn('Durable.invokeTool')(function* (
  server: Server,
  input: Parameters<Execute>[0],
  api: ToolExecutionApi,
  context: Context,
) {
  const checked = yield* validate(server, input)
  if (!checked.success) return failure(checked.error.message)
  const output = yield* Effect.tryPromise({
    try: async () =>
      server.execute(checked.value, {
        toolCallId: api.callId,
        messages: [],
        abortSignal: context.abortSignal,
        context: undefined,
      }),
    catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
  })
  const serialized = yield* Effect.try({
    try: () => ({
      text: Predicate.isString(output) ? output : JSON.stringify(output),
      json: JSON.stringify(output),
    }),
    catch: (cause) => new ToolOutputFailed({ toolName: server.name, cause }),
  })
  const json =
    serialized.json === undefined
      ? null
      : yield* decodeJsonText(serialized.json).pipe(
          Effect.mapError((cause) => new ToolOutputFailed({ toolName: server.name, cause })),
        )
  // Pi requires text content; non-serializable SDK results become a typed tool-output failure.
  const text = yield* decodeText(serialized.text).pipe(
    Effect.mapError((cause) => new ToolOutputFailed({ toolName: server.name, cause })),
  )
  return result({ text, output: json })
})

/** A wait hook has already received the durable answer before this tool begins. */
const answered = Effect.fn('Durable.answeredTool')(function* (
  name: string,
  api: ToolExecutionApi,
  context: Context,
) {
  const holds = yield* Pi.snapshot(api, Holds, api.conversationId, context)
  const settled = holds.pipe(Option.flatMapNullishOr((document) => document.settled[api.callId]))
  if (Option.isNone(settled) || settled.value.kind !== 'answered')
    return failure(`Tool ${name} was not answered`)
  const output = settled.value.output
  return result({ text: Predicate.isString(output) ? output : JSON.stringify(output), output })
})

/** Persist the open question before returning; the later answer is submitted separately and deduplicated. */
const asked = Effect.fn('Durable.askedTool')(function* (
  name: string,
  api: ToolExecutionApi,
  context: Context,
) {
  yield* Pi.commit(
    api,
    {
      token: Holds,
      conversationId: api.conversationId,
      change: (document) => {
        document.asked[api.callId] = name
      },
    },
    context,
  )
  const output = {
    status: 'asked',
    note: 'The answer will arrive later as a new message. Continue with other work.',
  }
  return result({ text: JSON.stringify(output), output })
})

type Bridged = { readonly plan: Plan; readonly replay: Replay; readonly execute: Execute }

/** Normalize every absent option once; the lookup then has an explicit default for every tool name. */
function bridge(name: string, tool: Tool, lookups: Lookups): Bridged {
  const rule = lookups.approval[name] ?? false
  const approval = Predicate.isFunction(rule) ? rule : () => rule
  if (tool.execute !== undefined) {
    const server: Server = {
      name,
      schema: asSchema(tool.inputSchema),
      execute: tool.execute.bind(tool),
    }
    return {
      plan: { approval, source: 'server' },
      replay: lookups.replay[name] ?? 'unsafe',
      execute: executeForPi((args, api, context) => invoke(server, args, api, context)),
    }
  }
  const source = lookups.answers[name] ?? 'wait'
  const program: Program =
    source === 'later'
      ? (_args, api, context) => asked(name, api, context)
      : (_args, api, context) => answered(name, api, context)
  return { plan: { approval: () => false, source }, replay: 'safe', execute: executeForPi(program) }
}

/** JSON Schema generation is lazy in the SDK; rejection is a registration failure naming the tool. */
const registration = Effect.fn('Durable.registerTool')(function* (
  name: string,
  tool: Tool,
  bridged: Bridged,
) {
  const parameters = yield* Effect.tryPromise({
    try: async () => asSchema(tool.inputSchema).jsonSchema,
    catch: (cause) => new ToolSchemaFailed({ toolName: name, cause }),
  })
  // TypeBox 1.3.27 TSchema is structural (an empty interface), so the SDK's schema needs no cast.
  return withPlan(
    {
      name,
      description: Predicate.isString(tool.description) ? tool.description : '',
      parameters,
      replay: bridged.replay,
      execute: bridged.execute,
    },
    bridged.plan,
  )
})

/** The hook only waits for plans that hold; a durable denial is Pi's existing block result. */
const before = Effect.fn('Durable.beforeTool')(function* (
  plans: ReadonlyMap<string, Plan>,
  call: Parameters<import('@earendil-works/pi-durable').ToolHooks['beforeTool']>[0],
  api: Parameters<import('@earendil-works/pi-durable').ToolHooks['beforeTool']>[1],
  context: Context,
) {
  const plan = Option.fromNullishOr(plans.get(call.name))
  if (Option.isNone(plan) || Option.isNone(holdKind(plan.value, copyJson(call.arguments))))
    return Option.none<{ block: string }>()
  const settled = yield* settlement(api, call.id, context)
  return settled.kind === 'denied'
    ? Option.some({ block: settled.reason })
    : Option.none<{ block: string }>()
})

/** AI SDK tools and the wait hook share one plan per tool; neither snapshots nor streams duplicate it. */
export const toolsExtension = Effect.fn('Durable.toolsExtension')(function* (
  name: string,
  tools: ToolSet,
  options: ToolsOptions,
) {
  const lookups: Lookups = {
    replay: options.replay ?? {},
    approval: options.approval ?? {},
    answers: options.answers ?? {},
  }
  const bridged = Object.entries(tools).map(([toolName, tool]) => ({
    toolName,
    tool,
    bridged: bridge(toolName, tool, lookups),
  }))
  const registrations = yield* Effect.forEach(
    bridged,
    (each) => registration(each.toolName, each.tool, each.bridged),
    { concurrency: 'unbounded' },
  )
  const plans = new Map(bridged.map((each) => [each.toolName, each.bridged.plan]))
  const waits = hook(ToolTask, {
    beforeTool: (call, api, context) =>
      Pi.runForPi(
        before(plans, call, api, context).pipe(Effect.map(Option.getOrUndefined)),
        context.abortSignal,
      ),
  })
  return defineExtension({ name, tools: registrations, hooks: [waits] })
})
