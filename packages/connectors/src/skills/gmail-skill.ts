import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { GmailConnector } from "../google/gmail.ts";

const connector = new GmailConnector();

// Tool registration must remain synchronous because Flue renders agent modules synchronously.
// Credentials are fetched asynchronously at invocation time instead of during agent render.
export function gmailTools() {
  return connector.tools().map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      const credentials = await getCredentialsForConnector("gmail");
      const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
      if (!valid) throw new Error("Gmail is not connected");
      return tool.execute(args, valid);
    },
  }));
}

export async function gmailStatus() {
  return getConnectorStatus("gmail");
}
