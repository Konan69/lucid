import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { GmailConnector } from "../google/gmail.ts";

const connector = new GmailConnector();

export function gmailTools() {
  const credentials = getCredentialsForConnector("gmail");
  const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
  if (!valid) return [];

  return connector.tools().map((tool) => ({
    ...tool,
    execute: (args: Record<string, unknown>) => tool.execute(args, valid),
  }));
}

export function gmailStatus() {
  return getConnectorStatus("gmail");
}
