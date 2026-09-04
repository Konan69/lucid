import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { DriveConnector } from "../google/drive.ts";

const connector = new DriveConnector();

export function driveTools() {
  const credentials = getCredentialsForConnector("drive");
  const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
  if (!valid) return [];

  return connector.tools().map((tool) => ({
    ...tool,
    execute: (args: Record<string, unknown>) => tool.execute(args, valid),
  }));
}

export function driveStatus() {
  return getConnectorStatus("drive");
}
