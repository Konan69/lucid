import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { CalendarConnector } from "../google/calendar.ts";

const connector = new CalendarConnector();

export function calendarTools() {
  const credentials = getCredentialsForConnector("calendar");
  const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
  if (!valid) return [];

  return connector.tools().map((tool) => ({
    ...tool,
    execute: (args: Record<string, unknown>) => tool.execute(args, valid),
  }));
}

export function calendarStatus() {
  return getConnectorStatus("calendar");
}
