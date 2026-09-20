import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ConnectionFailure, ConnectionToolFailure } from '../types.ts'

/** Executes one Google request and converts transport/status failures into typed domain errors. */
const requestGoogle = (
  tool: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<Response, ConnectionFailure | ConnectionToolFailure> =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: () => new ConnectionFailure({ message: 'The Google request failed' }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(
            new ConnectionToolFailure({
              tool,
              message: `Google API returned status ${response.status}`,
            }),
          ),
    ),
  )

/** Decodes one successful Google JSON response at the provider boundary. */
export const requestGoogleJson = <Output, Encoded>(
  tool: string,
  schema: Schema.Codec<Output, Encoded>,
  url: string,
  init?: RequestInit,
): Effect.Effect<Output, ConnectionFailure | ConnectionToolFailure> =>
  (() => {
    const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
    return requestGoogle(tool, url, init).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: () => new ConnectionFailure({ message: 'The Google request failed' }),
        }),
      ),
      Effect.flatMap((body) =>
        decodeJson(body).pipe(
          Effect.mapError(
            (error) =>
              new ConnectionToolFailure({
                tool,
                message: `Google API returned an invalid response: ${error.message}`,
              }),
          ),
        ),
      ),
    )
  })()

/** Reads a successful Google response as bounded text for file and event operations. */
export const requestGoogleText = (
  tool: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<string, ConnectionFailure | ConnectionToolFailure> =>
  requestGoogle(tool, url, init).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.text(),
        catch: () => new ConnectionFailure({ message: 'The Google request failed' }),
      }),
    ),
  )
