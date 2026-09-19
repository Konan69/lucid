import { Option, Schema } from "effect";

export type Connection = { url: string; token: string };

const ErrorResponseSchema = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String }),
);
const JsonResponseSchema = Schema.fromJsonString(Schema.Json);
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponseSchema);
const decodeJsonResponse = Schema.decodeUnknownSync(JsonResponseSchema);
export function normalizeServerUrl(value: string) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an http or https server address without credentials or query parameters.",
    );
  return url.toString().replace(/\/+$/, "");
}
export function createApi(
  connection: Connection,
  transport: typeof fetch = globalThis.fetch,
) {
  const root = normalizeServerUrl(connection.url);
  const headers: Record<string, string> = connection.token
    ? { authorization: `Bearer ${connection.token}` }
    : {};
  return {
    root,
    headers,
    // Direct runtime connections use its native route; the web gateway rewrites /api/vivid.
    agentUrl: (id: string) =>
      `${root}/${connection.token ? "agents/vivid" : "api/vivid"}/${encodeURIComponent(id)}`,
    async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      const multipart = body instanceof FormData;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const requestHeaders = { ...headers };
        if (body !== undefined && !multipart) requestHeaders["content-type"] = "application/json";
        const response = await transport(`${root}${path}`, {
          method,
          headers: requestHeaders,
          body:
            body === undefined
              ? undefined
              : multipart
                ? body
                : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const result = decodeErrorResponse(await response.text());
          throw new Error(
            Option.isSome(result)
              ? result.value.error
              : `Could not reach Vivid (${response.status}). Check your server in Settings.`,
          );
        }
        if (response.status === 204) {
          // SAFETY: HTTP 204 has no representation; callers select void for no-content routes.
          return undefined as T;
        }
        const decoded = decodeJsonResponse(await response.text());
        // SAFETY: this legacy generic is chosen by the route-owning caller after JSON validation.
        return decoded as T;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
export type Api = ReturnType<typeof createApi>;
