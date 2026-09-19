import { Effect, Schema } from "effect"
import { ConnectorToolExecutionFailed } from "../types.ts"

/** Executes one Google API request and returns the response after status validation. */
const requestGoogle = (
  tool: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<Response, ConnectorToolExecutionFailed> => Effect.tryPromise(() => fetch(url, init)).pipe(
  Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool, message: error.message })),
  Effect.flatMap((response) => response.ok
    ? Effect.succeed(response)
    : Effect.fail(new ConnectorToolExecutionFailed({
      tool,
      message: `Google API returned status ${response.status}.`,
    }))),
)

/** Decodes a Google API JSON response with the schema owned by its connector tool. */
export const requestGoogleJson = <Output, Encoded>(
  tool: string,
  schema: Schema.Codec<Output, Encoded, never, never>,
  url: string,
  init?: RequestInit,
): Effect.Effect<Output, ConnectorToolExecutionFailed> => requestGoogle(tool, url, init).pipe(
  Effect.flatMap((response) => Effect.tryPromise(() => response.text()).pipe(
    Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool, message: error.message })),
  )),
  Effect.flatMap((body) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError((error) => new ConnectorToolExecutionFailed({
      tool,
      message: `Google API returned an invalid response: ${error.message}`,
    })),
  )),
)

/** Reads a successful Google API response as bounded text. */
export const requestGoogleText = (
  tool: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<string, ConnectorToolExecutionFailed> => requestGoogle(tool, url, init).pipe(
  Effect.flatMap((response) => Effect.tryPromise(() => response.text()).pipe(
    Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool, message: error.message })),
  )),
)
