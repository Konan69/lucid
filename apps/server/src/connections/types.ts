import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { ConnectionId } from '@vivid/contracts'

/** A typed failure at the server-owned Connection boundary. Tokens are deliberately absent. */
export class ConnectionFailure extends Schema.TaggedError<ConnectionFailure>()(
  'ConnectionFailure',
  { message: Schema.String },
  { title: 'Connection failure' },
) {}

/** A failed provider tool operation with a stable title for logs and RPC mapping. */
export class ConnectionToolFailure extends Schema.TaggedError<ConnectionToolFailure>()(
  'ConnectionToolFailure',
  { tool: Schema.String, message: Schema.String },
  { title: 'Connection tool failure' },
) {}

/** Provider metadata rendered by the Connection settings surface. */
export interface ConnectionMetadata {
  readonly id: ConnectionId
  readonly name: string
  readonly description: string
  readonly icon: string
  readonly scopes: ReadonlyArray<string>
}

/** Credential values stay inside the server; this type never appears in an RPC payload. */
export interface ConnectionCredential {
  readonly id: string
  readonly connectorId: ConnectionId
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scope: string
  readonly createdAt: number
}

/** The small JSON-schema projection needed to expose a provider tool to the model. */
export interface ConnectionToolParameters {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ConnectionToolProperty>>
  readonly required?: ReadonlyArray<string>
}

export interface ConnectionToolProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean'
  readonly description?: string
}

/** A provider tool receives only a server-held access token and returns bounded JSON. */
export interface ConnectionTool {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectionToolParameters
  readonly execute: (
    input: Schema.Json,
    accessToken: string,
  ) => Effect.Effect<Schema.Json, ConnectionFailure | ConnectionToolFailure>
}

/** Decodes one tool's input/output schemas around its provider-specific implementation. */
export const defineConnectionTool = <
  Input,
  InputEncoded,
  Output extends Schema.Json,
  OutputEncoded,
>(definition: {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectionToolParameters
  readonly inputSchema: Schema.Codec<Input, InputEncoded>
  readonly outputSchema: Schema.Codec<Output, OutputEncoded>
  readonly run: (
    input: Input,
    accessToken: string,
  ) => Effect.Effect<Output, ConnectionFailure | ConnectionToolFailure>
}): ConnectionTool => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
  execute: (() => {
    const decodeInput = Schema.decodeUnknownEffect(definition.inputSchema)
    const decodeOutput = Schema.decodeUnknownEffect(definition.outputSchema)
    return Effect.fn(`ConnectionTool.${definition.name}`)(function* (input, accessToken) {
      const decoded = yield* decodeInput(input).pipe(
        Effect.mapError(
          (error) => new ConnectionToolFailure({ tool: definition.name, message: error.message }),
        ),
      )
      const output = yield* definition.run(decoded, accessToken)
      return yield* decodeOutput(output).pipe(
        Effect.mapError(
          (error) => new ConnectionToolFailure({ tool: definition.name, message: error.message }),
        ),
      )
    })
  })(),
})
