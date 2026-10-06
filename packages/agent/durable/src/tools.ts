import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  defineExtension,
  LiveDoc,
  hook,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { asSchema, type Tool, type ToolSet } from 'ai'
import { Effect, Option, Predicate, Schema } from 'effect'

import { ToolFailed, ToolOutputFailed, ToolSchemaFailed } from './errors.ts'
import {
  CallIdentity,
  holdIdOf,
  CallLookup,
  lookupSnapshots,
  holdKind,
  Holds,
  type Plan,
  settlement,
  withPlan,
} from './holds.ts'
import * as Pi from './pi.ts'
import { Delivery } from './delivery.ts'

/** Whether an interrupted call may run again after a crash. Pi's own default is unsafe. */
export type Replay = 'safe' | 'unsafe'

export type ToolsOptions = {
  /**
   * Must equal the host's HarnessSettings.toolExecution; Pi Durable does not expose that setting.
   * Default parallel. Every bridged registration states its mode explicitly instead of inheriting
   * the hidden default. Pi generation.js ORs the harness setting with per-tool modes: explicit
   * parallel cannot override a sequential harness; only sequential forces a round's mode.
   * Presentation reads this host declaration from the registration's plan.
   */
  readonly execution?: 'parallel' | 'sequential'
  /** These tools force a sequential round even in a parallel host; Pi sequences the whole round. */
  readonly sequential?: readonly string[]
  /** Only explicitly named server tools may rerun after a crash; the default protects side effects. */
  readonly replay?: Readonly<Record<string, Replay>>
  /** Pure predicates see Pi-validated JSON arguments before the SDK applies transformations. */
  readonly approval?: Readonly<Record<string, boolean | ((input: JsonValue) => boolean)>>
  /** Tools without execute wait inside the call by default; later delivers an answer as new input. */
  readonly answers?: Readonly<Record<string, 'wait' | 'later'>>
}

type Lookups = {
  readonly execution: NonNullable<ToolsOptions['execution']>
  readonly sequential: ReadonlySet<string>
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
  const validateArgs = schema.validate.bind(schema)
  return Effect.tryPromise({
    try: async function validateForSdk() {
      return validateArgs(args)
    },
    catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
  })
}

/**
 * The SDK's execute result is untyped at this third-party ingress. Serialize here, then decode the
 * actual persisted JSON once. Pi requires text content, so unserializable output is a typed failure.
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
    try: async function executeForSdk() {
      return server.execute(checked.value, {
        toolCallId: api.callId,
        messages: [],
        abortSignal: context.abortSignal,
        context: undefined,
      })
    },
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
  // Void tools have no JSON value; expose explicit null in both the durable result and model text.
  const text = serialized.text === undefined ? 'null' : serialized.text
  return result({ text, output: json })
})

/** A wait hook has already received the durable answer before this tool begins. */
const answered = Effect.fn('Durable.answeredTool')(function* (
  name: string,
  api: ToolExecutionApi,
  context: Context,
) {
  const holds = yield* Pi.snapshot(api, Holds, api.conversationId, context)
  const live = yield* Pi.snapshot(api, LiveDoc, api.conversationId, context)
  const found = lookupSnapshots(
    live,
    holds,
    CallIdentity.cases.Task.make({
      callId: api.callId,
      taskId: api.taskId,
      resultTask: Option.none(),
    }),
  )
  if (!CallLookup.guards.Settled(found) || found.settlement.kind !== 'answered')
    return failure(`Tool ${name} was not answered`)
  const output = found.settlement.output
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
        const holdId = holdIdOf(api.taskId)
        // Safe replay of this tool task must preserve an output already reserved by a person.
        if (document.asked[holdId] !== undefined || document.settled[holdId] !== undefined) return
        document.asked[holdId] = {
          taskId: api.taskId,
          callId: api.callId,
          toolName: name,
          delivery: Delivery.cases.Open.make({}),
        }
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

type Bridged = {
  readonly plan: Plan
  readonly replay: Replay
  readonly execute: Execute
  readonly executionMode: NonNullable<ToolsOptions['execution']>
}

/** Normalize every absent option once; the lookup then has an explicit default for every tool name. */
function bridge(name: string, tool: Tool, lookups: Lookups): Bridged {
  const executionMode = lookups.sequential.has(name) ? 'sequential' : lookups.execution
  const rule = lookups.approval[name] ?? false
  const approval = Predicate.isFunction(rule) ? rule : () => rule
  if (tool.execute !== undefined) {
    const server: Server = {
      name,
      schema: asSchema(tool.inputSchema),
      execute: tool.execute.bind(tool),
    }
    return {
      plan: { approval, source: 'server', execution: lookups.execution },
      executionMode,
      replay: lookups.replay[name] ?? 'unsafe',
      execute: executeForPi((args, api, context) => invoke(server, args, api, context)),
    }
  }
  const source = lookups.answers[name] ?? 'wait'
  const program: Program =
    source === 'later'
      ? (_args, api, context) => asked(name, api, context)
      : (_args, api, context) => answered(name, api, context)
  return {
    plan: { approval: () => false, source, execution: lookups.execution },
    executionMode,
    replay: 'safe',
    execute: executeForPi(program),
  }
}

/** JSON Schema generation is lazy in the SDK; rejection is a registration failure naming the tool. */
const registration = Effect.fn('Durable.registerTool')(function* (
  name: string,
  tool: Tool,
  bridged: Bridged,
) {
  const parameters = yield* Effect.tryPromise({
    try: async function schemaForSdk() {
      return asSchema(tool.inputSchema).jsonSchema
    },
    catch: (cause) => new ToolSchemaFailed({ toolName: name, cause }),
  })
  // TypeBox 1.3.27 TSchema is structural (an empty interface), so the SDK's schema needs no cast.
  return withPlan(
    {
      name,
      description: Predicate.isString(tool.description) ? tool.description : '',
      parameters,
      replay: bridged.replay,
      executionMode: bridged.executionMode,
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
  const live = yield* Pi.snapshot(api, LiveDoc, api.conversationId, context)
  const holds = yield* Pi.snapshot(api, Holds, api.conversationId, context)
  const found = lookupSnapshots(
    live,
    holds,
    CallIdentity.cases.Task.make({
      callId: call.id,
      taskId: api.taskId,
      resultTask: Option.none(),
    }),
  )
  if (CallLookup.guards.Duplicate(found)) return Option.some({ block: 'duplicate tool call id' })
  const plan = Option.fromNullishOr(plans.get(call.name))
  if (Option.isNone(plan) || Option.isNone(holdKind(plan.value, copyJson(call.arguments))))
    return Option.none<{ block: string }>()
  const settled = yield* settlement(api, call.id, context)
  return settled.kind === 'denied'
    ? Option.some({ block: settled.reason })
    : Option.none<{ block: string }>()
})

/** Pi's named hook adapter forwards cancellation into the sole settlement program. */
function beforeForPi(plans: ReadonlyMap<string, Plan>) {
  return function beforeTool(
    call: Parameters<import('@earendil-works/pi-durable').ToolHooks['beforeTool']>[0],
    api: Parameters<import('@earendil-works/pi-durable').ToolHooks['beforeTool']>[1],
    context: Context,
  ) {
    return Pi.runForPi(
      before(plans, call, api, context).pipe(Effect.map(Option.getOrUndefined)),
      context.abortSignal,
    )
  }
}

/** AI SDK tools and the wait hook share one plan per tool; neither snapshots nor streams duplicate it. */
export const toolsExtension = Effect.fn('Durable.toolsExtension')(function* (
  name: string,
  tools: ToolSet,
  options: ToolsOptions,
) {
  const lookups: Lookups = {
    execution: options.execution ?? 'parallel',
    sequential: new Set(options.sequential ?? []),
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
  const waits = hook(ToolTask, { beforeTool: beforeForPi(plans) })
  return defineExtension({ name, tools: registrations, hooks: [waits] })
})
