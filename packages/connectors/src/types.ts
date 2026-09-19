import type { ConnectionId } from '@vivid/contracts'
import { Effect, Schema } from 'effect'

/** Connector identifier shared with the runtime HTTP contract. */
export type ConnectorId = ConnectionId

/** Current authorization state for one Connection. */
export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Stable product metadata for one Connection implementation. */
export interface ConnectorMetadata {
  readonly id: ConnectorId
  readonly name: string
  readonly description: string
  readonly icon: string
  readonly scopes: ReadonlyArray<string>
}

/** Persisted OAuth credential held outside model context. */
export interface ConnectorCredential {
  readonly id: string
  readonly connectorId: ConnectorId
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scope: string
  readonly createdAt: number
}

/** Authority implemented by each external Connection. */
export interface Connector {
  metadata(): ConnectorMetadata
  getAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ConnectorCredential>
  refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential>
  revokeCredential(credentialId: string): Promise<void>
}

/** Primitive JSON Schema property supported by the Flue tool adapter. */
export interface ConnectorToolProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean'
  readonly description?: string
}

/** JSON Schema projection retained for Flue's current Valibot adapter. */
export interface ConnectorToolParameters {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ConnectorToolProperty>>
  readonly required?: ReadonlyArray<string>
}

/** Tool input failed its owned Effect Schema. */
export class ConnectorToolInputInvalid extends Schema.TaggedError<ConnectorToolInputInvalid>()(
  'ConnectorToolInputInvalid',
  {
    tool: Schema.String,
    message: Schema.String,
  },
  { title: 'Connector tool input invalid' },
) {}

/** Connector or provider execution failed after valid input. */
export class ConnectorToolExecutionFailed extends Schema.TaggedError<ConnectorToolExecutionFailed>()(
  'ConnectorToolExecutionFailed',
  {
    tool: Schema.String,
    message: Schema.String,
  },
  { title: 'Connector tool execution failed' },
) {}

/** Tool output failed its owned Effect Schema. */
export class ConnectorToolOutputInvalid extends Schema.TaggedError<ConnectorToolOutputInvalid>()(
  'ConnectorToolOutputInvalid',
  {
    tool: Schema.String,
    message: Schema.String,
  },
  { title: 'Connector tool output invalid' },
) {}

/** Typed failures exposed by connector tool invocation. */
export const ConnectorToolFailure = Schema.Union([
  ConnectorToolInputInvalid,
  ConnectorToolExecutionFailed,
  ConnectorToolOutputInvalid,
])
/** Decoded connector tool failure. */
export type ConnectorToolFailure = typeof ConnectorToolFailure.Type

/** JSON values accepted at the model-tool boundary before concrete schema decoding. */
export const ConnectorToolInput = Schema.Json
export type ConnectorToolInput = typeof ConnectorToolInput.Type

/** Existential connector tool used when heterogeneous tools share one registry. */
export interface ConnectorTool {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectorToolParameters
  readonly inputSchema: Schema.Top
  readonly outputSchema: Schema.Top
  execute(
    input: ConnectorToolInput,
    credential: ConnectorCredential,
  ): Effect.Effect<unknown, ConnectorToolFailure>
}

/** Connector tool retaining its concrete input and output schemas. */
export interface TypedConnectorTool<
  Input,
  InputEncoded,
  Output,
  OutputEncoded,
> extends ConnectorTool {
  readonly inputSchema: Schema.Codec<Input, InputEncoded>
  readonly outputSchema: Schema.Codec<Output, OutputEncoded>
  execute(
    input: ConnectorToolInput,
    credential: ConnectorCredential,
  ): Effect.Effect<Output, ConnectorToolFailure>
}

/** Values required to construct a schema-owned connector tool. */
export interface ConnectorToolDefinition<Input, InputEncoded, Output, OutputEncoded> {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectorToolParameters
  readonly inputSchema: Schema.Codec<Input, InputEncoded>
  readonly outputSchema: Schema.Codec<Output, OutputEncoded>
  readonly run: (
    input: Input,
    credential: ConnectorCredential,
  ) => Effect.Effect<Output, ConnectorToolExecutionFailed>
}

class ConnectorToolImplementation<
  Input,
  InputEncoded,
  Output,
  OutputEncoded,
> implements TypedConnectorTool<Input, InputEncoded, Output, OutputEncoded> {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectorToolParameters
  readonly inputSchema: Schema.Codec<Input, InputEncoded>
  readonly outputSchema: Schema.Codec<Output, OutputEncoded>
  private readonly runTool: ConnectorToolDefinition<
    Input,
    InputEncoded,
    Output,
    OutputEncoded
  >['run']

  constructor(definition: ConnectorToolDefinition<Input, InputEncoded, Output, OutputEncoded>) {
    this.name = definition.name
    this.description = definition.description
    this.parameters = definition.parameters
    this.inputSchema = definition.inputSchema
    this.outputSchema = definition.outputSchema
    this.runTool = definition.run
  }

  /** Decodes model input and provider output around the narrow Promise adapter. */
  execute(
    input: ConnectorToolInput,
    credential: ConnectorCredential,
  ): Effect.Effect<Output, ConnectorToolFailure> {
    const { inputSchema, name, outputSchema, runTool } = this
    return Effect.fn(`ConnectorTool.${name}`)(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(inputSchema)(input).pipe(
        Effect.mapError(
          (error) => new ConnectorToolInputInvalid({ tool: name, message: error.message }),
        ),
      )
      const output = yield* runTool(decoded, credential)
      return yield* Schema.decodeUnknownEffect(outputSchema)(output).pipe(
        Effect.mapError(
          (error) => new ConnectorToolOutputInvalid({ tool: name, message: error.message }),
        ),
      )
    })()
  }
}

/** Creates one connector tool whose implementation receives only decoded input. */
export const defineConnectorTool = <Input, InputEncoded, Output, OutputEncoded>(
  definition: ConnectorToolDefinition<Input, InputEncoded, Output, OutputEncoded>,
): TypedConnectorTool<Input, InputEncoded, Output, OutputEncoded> =>
  new ConnectorToolImplementation(definition)

/** Credential-bound connector tool exposed to one Vivid runtime. */
export interface BoundConnectorTool {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectorToolParameters
  readonly inputSchema: Schema.Top
  readonly outputSchema: Schema.Top
  execute(input: ConnectorToolInput): Effect.Effect<unknown, ConnectorToolFailure>
}

/** Connector that contributes tools to a Vivid runtime. */
export interface ConnectorWithTools extends Connector {
  tools(): ReadonlyArray<ConnectorTool>
}
