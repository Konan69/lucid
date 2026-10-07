import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import {
  type ConversationId,
  type TaskId,
  defineExtension,
  LiveDoc,
  hook,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable'
import { asSchema, type Tool, type ToolSet } from 'ai'
import { Cause, Data, Effect, Option, Predicate, Schema } from 'effect'

import {
  ToolApprovalUnsupported,
  ToolApprovalContextUnavailable,
  ToolContextFailed,
  ToolFailed,
  ToolOutputFailed,
  ToolSchemaFailed,
} from './errors.ts'
import {
  CallIdentity,
  holdIdOf,
  CallLookup,
  lookupSnapshots,
  holdKind,
  Holds,
  type Plan,
  type Source,
  settlement,
  withPlan,
} from './holds.ts'
import * as Pi from './pi.ts'
import { Delivery } from './delivery.ts'
import { inputContent } from './input.ts'

/** Whether an interrupted call may run again after a crash. Pi's own default is unsafe. */
export type Replay = 'safe' | 'unsafe'

/** Pi persists these identities with the tool task, preserving them across safe replay. */
export type ToolScope = {
  readonly conversationId: ConversationId
  readonly taskId: TaskId
  readonly callId: string
  readonly toolName: string
}

export type ToolsOptions = {
  /** Resolve SDK context once per execution attempt; absence supplies the durable ToolScope itself. */
  readonly context?: (scope: ToolScope) => Effect.Effect<unknown, unknown>

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
  /** Own entries opt server tools into crash replay; inherited keys are ignored, default unsafe. */
  readonly replay?: Readonly<Record<string, Replay>>
  /**
   * An own host option wins over the tool's needsApproval, including explicit false.
   * Answer-only tools refuse true or a predicate: Pi cannot hold for both approval and an answer.
   */
  readonly approval?: Readonly<Record<string, boolean | ((input: JsonValue) => boolean)>>
  /** Own entries select wait/later for answer-only tools; default wait. Later answers are new input. */
  readonly answers?: Readonly<Record<string, 'wait' | 'later'>>
}

type Lookups = {
  readonly context: Option.Option<NonNullable<ToolsOptions['context']>>
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
  ToolContextFailed | ToolFailed | ToolOutputFailed | import('./errors.ts').PiFailed
>

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.MutableJson))

/** SDK execute is an untyped ingress; recognize its async-iterator protocol before JSON encoding. */
const isAsyncOutput = Schema.is(
  Schema.declare<AsyncIterable<SdkValue>>(
    (value): value is AsyncIterable<SdkValue> =>
      Predicate.hasProperty(value, Symbol.asyncIterator) &&
      Predicate.isFunction(value[Symbol.asyncIterator]),
  ),
)

/** Decode only representations Pi can carry; unsupported parts fail the entire conversion. */
const ImageMedia = Schema.String
const ImageData = Schema.Union([
  Schema.String,
  Schema.instanceOf(Uint8Array),
  Schema.instanceOf(ArrayBuffer),
])
const ModelPart = Schema.Union([
  Schema.Struct({ type: Schema.tag('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.tag('image-data'), data: Schema.String, mediaType: ImageMedia }),
  Schema.Struct({ type: Schema.tag('file-data'), data: Schema.String, mediaType: ImageMedia }),
  Schema.Struct({
    type: Schema.tag('file'),
    mediaType: ImageMedia,
    data: Schema.Struct({ type: Schema.tag('data'), data: ImageData }),
  }),
]).pipe(Schema.toTaggedUnion('type'))
const ModelOutput = Schema.Union([
  Schema.Struct({ type: Schema.tag('text'), value: Schema.String }),
  Schema.Struct({ type: Schema.tag('json'), value: Schema.MutableJson }),
  Schema.Struct({ type: Schema.tag('content'), value: Schema.Array(ModelPart) }),
]).pipe(Schema.toTaggedUnion('type'))
const decodeModelOutput = Schema.decodeUnknownEffect(ModelOutput)

/**
 * Reuse user-picture admission: canonical base64 and PNG/JPEG/GIF/WebP matching signatures.
 * Tool output has no size policy option: decoded image size remains unbounded, as with user input
 * when maxPartBytes is absent. This adapter never fetches remote content.
 */
const modelImage = Effect.fn('Durable.toolImage')(function* (
  data: string,
  mediaType: string,
  name: string,
) {
  const content = yield* inputContent(
    [{ type: 'file', mediaType, url: `data:${mediaType};base64,${data}` }],
    {},
  ).pipe(Effect.mapError((cause) => new ToolOutputFailed({ toolName: name, cause })))
  // An array input must produce native blocks; a future admission change cannot silently emit text.
  if (Predicate.isString(content))
    return yield* new ToolOutputFailed({
      toolName: name,
      cause: new Error('Expected image blocks'),
    })
  return content
})

/** Preserve SDK base64 strings and encode byte payloads before the shared image admission. */
function modelPart(value: typeof ModelPart.Type, name: string) {
  return ModelPart.match(value, {
    text: (part) => Effect.succeed([{ type: 'text' as const, text: part.text }]),
    'image-data': (part) => modelImage(part.data, part.mediaType, name),
    'file-data': (part) => modelImage(part.data, part.mediaType, name),
    file: (part) =>
      modelImage(
        Predicate.isString(part.data.data)
          ? part.data.data
          : Buffer.from(new Uint8Array(part.data.data)).toString('base64'),
        part.mediaType,
        name,
      ),
  })
}

/** Validate every projected part before returning anything; JSON uses SDK JSON.stringify semantics. */
function modelContent(value: typeof ModelOutput.Type, name: string) {
  return ModelOutput.match(value, {
    text: (output) => Effect.succeed([{ type: 'text' as const, text: output.value }]),
    json: (output) =>
      Effect.succeed([{ type: 'text' as const, text: JSON.stringify(output.value) }]),
    content: (output) =>
      Effect.forEach(output.value, (part) => modelPart(part, name)).pipe(
        Effect.map((parts) => parts.flat()),
      ),
  })
}

/** The SDK result's serialized text and JSON envelope are validated at its unsafe boundary. */
type Output = { readonly text: string; readonly output: JsonValue }

/** A bridged result preserves the tool's JSON output beside the text the model reads. */
const result = (output: Output): ToolExecutionResult => ({
  content: [{ type: 'text' as const, text: output.text }],
  details: { output: output.output },
})

/** Validation and missing answers are existing tool-error values, rather than infrastructure failures. */
const failure = (text: string): ToolExecutionResult => ({
  isError: true,
  content: [{ type: 'text' as const, text }],
})

/** Every execute callback runs exactly one Effect through the single Pi runtime ingress. */
function executeForPi(program: Program): Execute {
  return function execute(args, api, context) {
    return Pi.runForPi(program(args, api, context), context.abortSignal)
  }
}

/** A tool either executes locally or receives its durable person-supplied answer. */
type Execution = Data.TaggedEnum<{
  Server: { readonly execute: NonNullable<Tool<unknown, unknown, unknown>['execute']> }
  Wait: {}
  Later: {}
}>
const Execution = Data.taggedEnum<Execution>()

type Server = {
  readonly name: string
  readonly schema: ReturnType<typeof asSchema>
  readonly execution: Execution
  readonly contextSchema: Option.Option<ReturnType<typeof asSchema>>
  readonly context: Lookups['context']
  readonly toModelOutput: Option.Option<
    NonNullable<Tool<unknown, unknown, unknown>['toModelOutput']>
  >
}

/** SDK validators may be synchronous or Promise-based; normalize only this external operation. */
type SdkValue = Parameters<NonNullable<ReturnType<typeof asSchema>['validate']>>[0]

/** This SDK schema ingress accepts exactly the value type its validator declares. */
const validate = (schema: ReturnType<typeof asSchema>, args: SdkValue, name: string) => {
  if (schema.validate === undefined) return Effect.succeed({ success: true as const, value: args })
  const validateArgs = schema.validate.bind(schema)
  return Effect.tryPromise({
    try: async function validateForSdk() {
      return validateArgs(args)
    },
    catch: (cause) => new ToolFailed({ toolName: name, cause }),
  })
}

/**
 * A user resolver is an SDK boundary: reject non-Effects before the fiber runtime sees them, and
 * translate its typed failures and defects once. Cancellation retains interruption semantics.
 */
const resolveContext = Effect.fn('Durable.toolContext')(function* (
  resolve: NonNullable<ToolsOptions['context']>,
  scope: ToolScope,
) {
  return yield* Effect.suspend(() => {
    const resolved = resolve(scope)
    // Invalid Promise resolvers are not awaited; observe rejection while reporting the contract error.
    if (Predicate.isPromiseLike(resolved))
      resolved.then(
        () => {},
        () => {},
      )
    if (Effect.isEffect(resolved)) return resolved
    return Effect.fail(new Error('Context resolver must return an Effect'))
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(
            new ToolContextFailed({ toolName: scope.toolName, cause: Cause.squash(cause) }),
          ),
    ),
  )
})

/** Observe SDK cleanup rejection without waiting for return queued behind an uncooperative next. */
const stopIterator = Effect.fn('Durable.stopToolIterator')(
  (iterator: AsyncIterator<SdkValue, SdkValue, void>) =>
    Effect.sync(() => {
      // Deliberately detach only this external cleanup promise; Pi must regain conversation ownership.
      void Promise.resolve()
        .then(() => {
          if (iterator.return !== undefined) return iterator.return()
          return undefined
        })
        .then(
          () => {},
          () => {},
        )
    }),
)

/** Serialize the SDK ingress once before storing JSON; void remains the bridge's explicit null output. */
const serializedOutput = Effect.fn('Durable.serializeToolOutput')(function* (
  output: SdkValue,
  name: string,
) {
  const serialized = yield* Effect.try({
    try: () => ({
      text: Predicate.isString(output) ? output : JSON.stringify(output),
      json: JSON.stringify(output),
    }),
    catch: (cause) => new ToolOutputFailed({ toolName: name, cause }),
  })
  const json =
    serialized.json === undefined
      ? null
      : yield* decodeJsonText(serialized.json).pipe(
          Effect.mapError((cause) => new ToolOutputFailed({ toolName: name, cause })),
        )
  // Void tools have no JSON value; expose explicit null in both the durable result and model text.
  const text = serialized.text === undefined ? 'null' : serialized.text
  return { text, output: json }
})

/**
 * The SDK's execute result is untyped at this third-party ingress. Serialize here, then decode the
 * actual persisted JSON once. SDK provider-utils/types/execute-tool.ts:44–50 selects the last yielded
 * result, ignoring the iterator return value. Earlier preliminary values are not streamed here.
 * Cancellation requests iterator return without waiting for uncooperative generator cleanup.
 */
const invoke = Effect.fn('Durable.invokeTool')(function* (
  server: Server,
  input: Parameters<Execute>[0],
  api: ToolExecutionApi,
  context: Context,
) {
  const checked = yield* validate(server.schema, input, server.name)
  if (!checked.success) return failure(checked.error.message)
  const scope: ToolScope = {
    conversationId: api.conversationId,
    taskId: api.taskId,
    callId: api.callId,
    toolName: server.name,
  }
  const resolved = yield* Option.match(server.context, {
    onNone: () => Effect.succeed(scope),
    onSome: (resolve) => resolveContext(resolve, scope),
  })
  // ai/src/generate-text/validate-tool-context.ts:21–33 validates and normalizes before execute.
  const toolContext = yield* Option.match(server.contextSchema, {
    onNone: () => Effect.succeed(resolved),
    onSome: (schema) =>
      validate(schema, resolved, server.name).pipe(
        Effect.mapError((cause) => new ToolContextFailed({ toolName: server.name, cause })),
        Effect.flatMap((validated) =>
          validated.success
            ? Effect.succeed(validated.value)
            : Effect.fail(new ToolContextFailed({ toolName: server.name, cause: validated.error })),
        ),
      ),
  })
  const executed = yield* Execution.$match(server.execution, {
    Server: function executeForSdk(execution) {
      return Effect.tryPromise({
        try: () =>
          Promise.resolve(
            execution.execute(checked.value, {
              toolCallId: api.callId,
              messages: [],
              abortSignal: context.abortSignal,
              context: toolContext,
            }),
          ),
        catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
      })
    },
    Wait: () => answered(server.name, api, context),
    Later: () => asked(server.name, api, context),
  })
  // Execute, iterator pulls and model conversion share the classified SDK ingress. Each pending
  // pull owns cancellation cleanup, with no awaited operation between pulls or after exhaustion.
  const iterate = Effect.fn('Durable.iterateToolOutput')(function* (
    iterable: AsyncIterable<SdkValue>,
  ) {
    const iterator = yield* Effect.try({
      try: () => iterable[Symbol.asyncIterator](),
      catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
    })
    let last: SdkValue = undefined
    while (true) {
      const next = yield* Effect.tryPromise({
        try: () => iterator.next(),
        catch: (cause) => new ToolFailed({ toolName: server.name, cause }),
      }).pipe(Effect.onInterrupt(() => stopIterator(iterator)))
      if (next.done) return last
      last = next.value
    }
  })
  const output = yield* isAsyncOutput(executed) ? iterate(executed) : Effect.succeed(executed)
  const encoded = yield* serializedOutput(output, server.name)
  // Later acknowledges an open question; answers.ts admits its real answer as separate user input.
  if (Execution.$is('Later')(server.execution) || Option.isNone(server.toModelOutput))
    return result(encoded)
  // ai/src/prompt/create-tool-model-output.ts:32–33 passes the validated input and original output.
  const convert = server.toModelOutput.value
  const model = yield* Effect.tryPromise({
    try: async function executeForSdk() {
      return convert({ toolCallId: api.callId, input: checked.value, output })
    },
    catch: (cause) => new ToolOutputFailed({ toolName: server.name, cause }),
  })
  const projected = yield* decodeModelOutput(model).pipe(
    Effect.mapError(
      () =>
        new ToolOutputFailed({
          toolName: server.name,
          cause: new Error(
            `Tool ${server.name} model output is unsupported; use text, JSON or inline PNG, JPEG, GIF or WebP data`,
          ),
        }),
    ),
  )
  const content = yield* modelContent(projected, server.name)
  return { content, details: { output: encoded.output } }
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
    return yield* new ToolFailed({
      toolName: name,
      cause: new Error(`Tool ${name} was not answered`),
    })
  return found.settlement.output
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
  return output
})

type Bridged = {
  readonly plan: Plan
  readonly replay: Replay
  readonly execute: Execute
  readonly executionMode: NonNullable<ToolsOptions['execution']>
}

/**
 * holds.ts Plan only supplies input during hook, presentation and recovery. Refuse unavailable
 * SDK options on access rather than manufacture identity or resolve request authority repeatedly.
 * ai/src/generate-text/resolve-tool-approval.ts:115–123 passes precisely these three fields.
 */
function approvalOptions(name: string): import('ai').ToolExecutionOptions<SdkValue> {
  return {
    get toolCallId(): string {
      throw new ToolApprovalContextUnavailable({ toolName: name, field: 'toolCallId' })
    },
    get messages(): import('ai').ModelMessage[] {
      throw new ToolApprovalContextUnavailable({ toolName: name, field: 'messages' })
    },
    get context(): SdkValue {
      throw new ToolApprovalContextUnavailable({ toolName: name, field: 'context' })
    },
  }
}

/** Prototype properties are not declarations, even for tool names such as constructor or __proto__. */
function ownOption<Value>(
  options: Readonly<Record<string, Value>>,
  name: string,
): Option.Option<Value> {
  return Object.hasOwn(options, name) ? Option.fromNullishOr(options[name]) : Option.none()
}

/** Input-only predicates are synchronous replay rules; a Promise is never interpreted as true. */
function approvalForTool(
  name: string,
  tool: Pick<Tool<unknown, unknown, unknown>, 'needsApproval'>,
  lookups: Lookups,
): Plan['approval'] {
  const override = ownOption(lookups.approval, name)
  if (Option.isSome(override)) {
    const rule = override.value
    return Predicate.isFunction(rule) ? rule : () => rule
  }
  const rule = tool.needsApproval
  if (rule === undefined) return () => false
  if (!Predicate.isFunction(rule)) return () => rule
  if (Object.prototype.toString.call(rule) === '[object AsyncFunction]')
    throw new ToolApprovalUnsupported({ toolName: name })
  return (input) => {
    const answer = rule(input, approvalOptions(name))
    if (Predicate.isBoolean(answer)) return answer
    // Observe only rejection of the unsupported SDK Promise; never await or accept its boolean.
    if (Predicate.isPromiseLike(answer))
      answer.then(
        () => {},
        () => {},
      )
    throw new ToolApprovalUnsupported({ toolName: name })
  }
}

/** Keep the execute/answer distinction explicit rather than assembling partially executable tools. */
function executionForTool(tool: Tool, source: Source): Execution {
  if (tool.execute !== undefined) return Execution.Server({ execute: tool.execute.bind(tool) })
  if (source === 'later') return Execution.Later()
  return Execution.Wait()
}

/** Normalize every absent option once; the lookup then has an explicit default for every tool name. */
function bridge(name: string, tool: Tool, lookups: Lookups): Bridged {
  const executionMode = lookups.sequential.has(name) ? 'sequential' : lookups.execution
  const approval = approvalForTool(name, tool, lookups)
  const source =
    tool.execute === undefined
      ? Option.getOrElse(ownOption(lookups.answers, name), () => 'wait' as const)
      : 'server'
  const execution = executionForTool(tool, source)
  const server: Server = {
    name,
    schema: asSchema(tool.inputSchema),
    execution,
    contextSchema: Option.map(Option.fromNullishOr(tool.contextSchema), asSchema),
    context: lookups.context,
    toModelOutput: Option.map(Option.fromNullishOr(tool.toModelOutput), (convert) =>
      convert.bind(tool),
    ),
  }
  return {
    plan: {
      approval: source === 'server' ? approval : () => false,
      source,
      execution: lookups.execution,
    },
    executionMode,
    replay:
      source === 'server'
        ? Option.getOrElse(ownOption(lookups.replay, name), () => 'unsafe' as const)
        : 'safe',
    execute: executeForPi((args, api, context) => invoke(server, args, api, context)),
  }
}

/** Pi Tool lacks SDK lifecycle, discovery and kind contracts; refuse behavior that would silently change. */
function unsupported(name: string, tool: Tool, lookups: Lookups): Option.Option<string> {
  if (tool.type === 'provider') return Option.some('provider-defined and provider-executed tools')
  if (tool.type === 'dynamic') return Option.some('dynamic SDK UI tool parts')
  if (Predicate.isFunction(tool.description)) return Option.some('context-dependent descriptions')
  if (tool.deferLoading === true) return Option.some('deferred tool discovery')
  if (tool.providerOptions !== undefined && Object.keys(tool.providerOptions).length > 0)
    return Option.some('provider-specific tool options')
  const callback = (['onInputStart', 'onInputDelta', 'onInputAvailable'] as const).find(
    (field) => tool[field] !== undefined,
  )
  if (callback !== undefined) return Option.some(callback)
  return unsupportedApproval(name, tool, lookups)
}

/** A disabled host policy overrides the SDK; any enabled policy needs an unrepresentable second hold. */
function unsupportedApproval(name: string, tool: Tool, lookups: Lookups): Option.Option<string> {
  if (tool.execute !== undefined) return Option.none()
  const override = ownOption(lookups.approval, name)
  if (Option.isSome(override))
    return override.value === false
      ? Option.none()
      : Option.some('approval before person-supplied output')
  if (tool.needsApproval === undefined || tool.needsApproval === false) return Option.none()
  return Option.some('approval before person-supplied output')
}

/**
 * JSON Schema generation is lazy in the SDK; rejection is a registration failure naming the tool.
 * title, inputExamples and metadata have no projection in Pi's native declaration. outputSchema is
 * not used to validate local execute results by SDK execute-tool.ts either; persistence validates JSON.
 */
const registration = Effect.fn('Durable.registerTool')(function* (
  name: string,
  tool: Tool,
  bridged: Bridged,
  lookups: Lookups,
) {
  const unsupportedField = unsupported(name, tool, lookups)
  if (Option.isSome(unsupportedField))
    return yield* new ToolSchemaFailed({
      toolName: name,
      cause: new Error(`Pi Durable cannot represent ${unsupportedField.value}`),
    })
  const parameters = yield* Effect.tryPromise({
    try: async function schemaForSdk() {
      return asSchema(tool.inputSchema).jsonSchema
    },
    catch: (cause) => new ToolSchemaFailed({ toolName: name, cause }),
  })
  // SDK strict only affects supporting providers. Pi's prefer mode likewise permits unsupported
  // providers; it also falls back for schemas outside Pi's strict subset (constrained-sampling.js).
  const constrainedSampling =
    tool.strict === true ? { type: 'json_schema' as const, strict: 'prefer' as const } : tool.strict
  // TypeBox 1.3.27 TSchema is structural (an empty interface), so the SDK's schema needs no cast.
  return withPlan(
    {
      name,
      description: Predicate.isString(tool.description) ? tool.description : '',
      parameters,
      constrainedSampling,
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
    context: Option.fromNullishOr(options.context),
    execution: options.execution ?? 'parallel',
    sequential: new Set(options.sequential ?? []),
    replay: options.replay ?? {},
    approval: options.approval ?? {},
    answers: options.answers ?? {},
  }
  const bridged = yield* Effect.forEach(Object.entries(tools), ([toolName, tool]) =>
    Effect.try({
      try: () => ({ toolName, tool, bridged: bridge(toolName, tool, lookups) }),
      catch: (cause) =>
        cause instanceof ToolApprovalUnsupported
          ? cause
          : new ToolSchemaFailed({ toolName, cause }),
    }),
  )
  const registrations = yield* Effect.forEach(
    bridged,
    (each) => registration(each.toolName, each.tool, each.bridged, lookups),
    { concurrency: 'unbounded' },
  )
  const plans = new Map(bridged.map((each) => [each.toolName, each.bridged.plan]))
  const waits = hook(ToolTask, { beforeTool: beforeForPi(plans) })
  return defineExtension({ name, tools: registrations, hooks: [waits] })
})
