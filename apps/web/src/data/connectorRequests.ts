import { Option, Schema } from "effect";

export const connectorNames = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
} as const;

export type ConnectorId = keyof typeof connectorNames;
const ConnectorRequestSchema = Schema.Struct({
  kind: Schema.Literal("connector-request"),
  connector: Schema.Literals(["gmail", "calendar", "drive"] as const),
  reason: Schema.String,
});
export type ConnectorRequest = typeof ConnectorRequestSchema.Type;
export type ConnectorStatus = {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
};

const decodeConnectorRequest = Schema.decodeUnknownOption(ConnectorRequestSchema);
const decodeString = Schema.decodeUnknownOption(Schema.String);

// The wire decoder establishes the connector vocabulary before the UI applies its stricter
// display-length invariant.
export function normalizeConnectorRequest(value: ConnectorRequest): ConnectorRequest | null {
  const reason = value.reason.trim();
  if (reason.length === 0 || reason.length > 400) return null;
  return ConnectorRequestSchema.make({
    kind: "connector-request",
    connector: value.connector,
    reason,
  });
}

// This compatibility boundary supports persisted messages read outside the live Conversation
// adapter; live Flue output is decoded with the shared contract before normalization.
export function readConnectorRequest(output: unknown): ConnectorRequest | null {
  const decoded = decodeConnectorRequest(output);
  return Option.isSome(decoded) ? normalizeConnectorRequest(decoded.value) : null;
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
