import { getCredentialsForConnector, getConnectorStatus } from "../store.ts";
import { CalendarConnector } from "../google/calendar.ts";

const connector = new CalendarConnector();

export function calendarTools() {
  return connector.tools().map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      const credentials = await getCredentialsForConnector("calendar");
      const valid = credentials.find((c) => c.expiresAt > Date.now() + 60_000);
      if (!valid) throw new Error("Google Calendar is not connected");
      return tool.execute(args, valid);
    },
  }));
}

export async function calendarStatus() {
  return getConnectorStatus("calendar");
}
