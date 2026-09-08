import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { DriveConnector } from "../google/drive.ts";

const connector = new DriveConnector();

export function driveTools() {
  return connector.tools().map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      const credentials = await getCredentialsForConnector("drive");
      const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
      if (!valid) throw new Error("Google Drive is not connected");
      return tool.execute(args, valid);
    },
  }));
}

export async function driveStatus() {
  return getConnectorStatus("drive");
}
