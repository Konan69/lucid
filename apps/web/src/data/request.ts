import { RuntimeErrorResponse } from "@vivid/contracts";
import { Effect, Option, Schema } from "effect";

/** A browser request failed before a screen could apply its domain response. */
export class ClientRequestFailed extends Schema.TaggedError<ClientRequestFailed>()(
  "ClientRequestFailed",
  {
    path: Schema.String,
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
    cause: Schema.Defect(),
  },
  { title: "Client request failed" },
) {}

const decodeErrorResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(RuntimeErrorResponse),
);

/**
 * Owns the browser Fetch boundary so callers receive either decoded domain data or one typed
 * failure. Decoders are supplied already compiled because each screen owns its response schema.
 */
export const request = Effect.fn("WebClient.request")(function*<Value>(
  path: string,
  decode: (input: string) => Value,
  init: RequestInit = {},
): Effect.fn.Return<Value, ClientRequestFailed> {
  const response = yield* Effect.tryPromise(() => fetch(path, init)).pipe(
    Effect.mapError((cause) => new ClientRequestFailed({
      path,
      status: null,
      message: "Could not reach Vivid.",
      cause,
    })),
  );
  const payload = yield* Effect.tryPromise(() => response.text()).pipe(
    Effect.mapError((cause) => new ClientRequestFailed({
      path,
      status: response.status,
      message: "Vivid returned an unreadable response.",
      cause,
    })),
  );
  if (!response.ok) {
    const body = decodeErrorResponse(payload);
    const message = Option.isSome(body)
      ? body.value.error
      : `Request failed (${response.status})`;
    return yield* Effect.fail(new ClientRequestFailed({
      path,
      status: response.status,
      message,
      cause: payload,
    }));
  }
  return yield* Effect.try(() => decode(payload)).pipe(
    Effect.mapError((cause) => new ClientRequestFailed({
      path,
      status: response.status,
      message: "Vivid returned invalid data.",
      cause,
    })),
  );
});

/** Successful empty responses have no value to decode. */
export function emptyResponse(): void {}
