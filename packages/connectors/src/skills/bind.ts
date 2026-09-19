import { Effect } from "effect"
import { getCredentialsForConnector } from "../store.ts"
import type {
  BoundConnectorTool,
  ConnectorId,
  ConnectorTool,
  ConnectorToolFailure,
  ConnectorToolParameters,
} from "../types.ts"
import { ConnectorToolExecutionFailed } from "../types.ts"
import type { Schema } from "effect"

class CredentialBoundTool implements BoundConnectorTool {
  readonly name: string
  readonly description: string
  readonly parameters: ConnectorToolParameters
  readonly inputSchema: Schema.Top
  readonly outputSchema: Schema.Top

  constructor(
    private readonly connectorId: ConnectorId,
    private readonly connectorName: string,
    private readonly tool: ConnectorTool,
  ) {
    this.name = tool.name
    this.description = tool.description
    this.parameters = tool.parameters
    this.inputSchema = tool.inputSchema
    this.outputSchema = tool.outputSchema
  }

  /** Loads a current credential before invoking the schema-owned tool. */
  execute(input: unknown): Effect.Effect<unknown, ConnectorToolFailure> {
    const { connectorId, connectorName, name, tool } = this
    return Effect.fn(`ConnectorTool.${name}.credential`)(function*() {
      const credentials = yield* Effect.tryPromise(() => getCredentialsForConnector(connectorId)).pipe(
        Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool: name, message: error.message })),
      )
      const credential = credentials.find((candidate) => candidate.expiresAt > Date.now() + 60_000)
      if (credential === undefined) {
        return yield* Effect.fail(new ConnectorToolExecutionFailed({
          tool: name,
          message: `${connectorName} is not connected`,
        }))
      }
      return yield* tool.execute(input, credential)
    })()
  }
}

/** Binds a heterogeneous tool registry to credentials loaded only at invocation. */
export const bindConnectorTools = (
  connectorId: ConnectorId,
  connectorName: string,
  tools: ReadonlyArray<ConnectorTool>,
): ReadonlyArray<BoundConnectorTool> => tools.map((tool) => new CredentialBoundTool(connectorId, connectorName, tool))
