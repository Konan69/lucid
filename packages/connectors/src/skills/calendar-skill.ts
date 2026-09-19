import { getConnectorStatus } from "../store.ts"
import { CalendarConnector } from "../google/calendar.ts"
import { bindConnectorTools } from "./bind.ts"

const connector = new CalendarConnector()

/** Registers Calendar tools synchronously and loads credentials only at invocation. */
export function calendarTools() {
  return bindConnectorTools("calendar", "Google Calendar", connector.tools())
}

/** Reads the current Calendar Connection state. */
export async function calendarStatus() {
  return getConnectorStatus("calendar")
}
