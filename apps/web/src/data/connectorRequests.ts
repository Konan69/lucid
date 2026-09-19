import { ConnectionRequestMessage, type ConnectionId } from "@vivid/contracts";
import { Option, Schema } from "effect";

export const connectorNames = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
} as const satisfies Record<ConnectionId, string>;

export type ConnectorId = ConnectionId;
export type ConnectorRequest = ConnectionRequestMessage;
export type ConnectorStatus = {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
};

const decodeConnectorRequest = Schema.decodeUnknownOption(ConnectionRequestMessage);
const decodeString = Schema.decodeUnknownOption(Schema.String);

// Persisted tool output is untrusted data. The shared wire contract establishes the connector
// vocabulary before the UI applies its stricter display-length invariant.
export function readConnectorRequest(output: unknown): ConnectorRequest | null {
  const decoded = decodeConnectorRequest(output);
  if (Option.isNone(decoded)) return null;
  const reason = decoded.value.reason.trim();
  if (reason.length === 0 || reason.length > 400) return null;
  return ConnectionRequestMessage.make({
    kind: "connector-request",
    connector: decoded.value.connector,
    reason,
  });
}

export function connectorContinuation(id: ConnectorId) {
  return `I've connected ${connectorNames[id]}. Please continue with my request.`;
}

export function authorizationAddress(value: unknown): string {
  const decoded = decodeString(value);
  if (Option.isNone(decoded))
    throw new Error("The connection returned an invalid sign-in address.");
  const url = new URL(decoded.value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The connection returned an invalid sign-in address.");
  return url.href;
}
