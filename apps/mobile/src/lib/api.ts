export type Connection = { url: string; token: string };
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
          const result = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            result?.error ??
              `Could not reach Vivid (${response.status}). Check your server in Settings.`,
          );
        }
        return response.status === 204
          ? (undefined as T)
          : (response.json() as Promise<T>);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
export type Api = ReturnType<typeof createApi>;
