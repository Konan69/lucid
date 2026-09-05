export const connectorNames = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
} as const;

export type ConnectorId = keyof typeof connectorNames;
export type ConnectorRequest = {
  kind: "connector-request";
  connector: ConnectorId;
  reason: string;
};
export type ConnectorStatus = {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
};

// Persisted tool output is untrusted data. Only known connector IDs become actions;
// authorization addresses always come from the authenticated connector API.
export function readConnectorRequest(output: unknown): ConnectorRequest | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  if (
    value.kind !== "connector-request" ||
    typeof value.connector !== "string" ||
    !Object.hasOwn(connectorNames, value.connector) ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 400
  )
    return null;
  return {
    kind: "connector-request",
    connector: value.connector as ConnectorId,
    reason: value.reason.trim(),
  };
}

export function connectorContinuation(id: ConnectorId) {
  return `I've connected ${connectorNames[id]}. Please continue with my request.`;
}

export function authorizationAddress(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("The connection returned an invalid sign-in address.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The connection returned an invalid sign-in address.");
  return url.href;
}
