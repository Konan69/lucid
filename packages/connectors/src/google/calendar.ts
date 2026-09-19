import { Effect, Schema } from "effect"
import type { ConnectorCredential, ConnectorMetadata, ConnectorTool, ConnectorWithTools } from "../types.ts"
import { ConnectorToolExecutionFailed, defineConnectorTool } from "../types.ts"
import { getGoogleAuthUrl, getGoogleConfig, refreshGoogleToken, revokeGoogleToken } from "./oauth.ts"
import { saveCredential, updateCredential, deleteCredential, getCredentialsForConnector } from "../store.ts"
import { requestGoogleJson, requestGoogleText } from "./request.ts"

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]

const CalendarDate = Schema.Struct({
  dateTime: Schema.optionalKey(Schema.String),
  date: Schema.optionalKey(Schema.String),
})
const CalendarEvent = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  description: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  start: CalendarDate,
  end: CalendarDate,
  htmlLink: Schema.String,
})
const CalendarEventList = Schema.Struct({ items: Schema.optionalKey(Schema.Array(CalendarEvent)) })
const CalendarEventOutput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  location: Schema.String,
  start: Schema.String,
  end: Schema.String,
  link: Schema.String,
})
const CreatedCalendarEvent = Schema.Struct({ id: Schema.String, htmlLink: Schema.String, summary: Schema.String })

/** Reads Google's date-time or all-day date representation without widening it. */
const calendarDate = (value: typeof CalendarDate.Type): string => value.dateTime ?? value.date ?? ""

export class CalendarConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: "calendar",
      name: "Google Calendar",
      description: "View and create calendar events",
      icon: "calendar",
      scopes: SCOPES,
    }
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state)
  }

  /** Exchanges an OAuth grant and persists the resulting Calendar credential. */
  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const tokenData = await import("./oauth.ts").then((module) => module.exchangeGoogleCode(config, code))
    return saveCredential({ ...tokenData, connectorId: "calendar" })
  }

  /** Refreshes and persists an expired Calendar credential. */
  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken)
    const updated = await updateCredential(credential.id, { accessToken, expiresAt })
    if (updated === null) throw new Error("Credential not found")
    return updated
  }

  /** Revokes a Calendar grant before deleting its local credential. */
  async revokeCredential(credentialId: string): Promise<void> {
    const credentials = await getCredentialsForConnector("calendar")
    const credential = credentials.find((candidate) => candidate.id === credentialId)
    if (credential !== undefined) await revokeGoogleToken(credential.accessToken)
    await deleteCredential(credentialId)
  }

  /** Returns Calendar tools with owned input and output schemas. */
  tools(): ReadonlyArray<ConnectorTool> {
    const listTool = "calendar_list_events"
    const createTool = "calendar_create_event"
    const deleteTool = "calendar_delete_event"
    const accessToken = (tool: string, credential: ConnectorCredential) => this.getAccessToken(tool, credential)
    return [
      defineConnectorTool({
        name: listTool,
        description: "List upcoming calendar events from Google Calendar.",
        parameters: {
          type: "object",
          properties: {
            timeMin: { type: "string", description: "Start of time range (ISO 8601, default: now)" },
            timeMax: { type: "string", description: "End of time range (ISO 8601, default: 7 days from now)" },
            maxResults: { type: "number", description: "Maximum events to return (default 10)" },
          },
        },
        inputSchema: Schema.Struct({
          timeMin: Schema.optionalKey(Schema.String),
          timeMax: Schema.optionalKey(Schema.String),
          maxResults: Schema.optionalKey(Schema.Number),
        }),
        outputSchema: Schema.Array(CalendarEventOutput),
        run: Effect.fn("CalendarConnector.listEvents")(function*(input, credential) {
          const token = yield* accessToken(listTool, credential)
          const timeMin = input.timeMin ?? new Date().toISOString()
          const timeMax = input.timeMax ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
          const maxResults = input.maxResults ?? 10
          const data = yield* requestGoogleJson(
            listTool,
            CalendarEventList,
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          return (data.items ?? []).map((event) => ({
            id: event.id,
            title: event.summary,
            description: event.description ?? "",
            location: event.location ?? "",
            start: calendarDate(event.start),
            end: calendarDate(event.end),
            link: event.htmlLink,
          }))
        }),
      }),
      defineConnectorTool({
        name: createTool,
        description: "Create a new event on Google Calendar.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title" },
            start: { type: "string", description: "Start time (ISO 8601)" },
            end: { type: "string", description: "End time (ISO 8601)" },
            description: { type: "string", description: "Event description" },
            location: { type: "string", description: "Event location" },
          },
          required: ["title", "start", "end"],
        },
        inputSchema: Schema.Struct({
          title: Schema.String,
          start: Schema.String,
          end: Schema.String,
          description: Schema.optionalKey(Schema.String),
          location: Schema.optionalKey(Schema.String),
        }),
        outputSchema: Schema.Struct({
          success: Schema.Literal(true),
          eventId: Schema.String,
          link: Schema.String,
          title: Schema.String,
        }),
        run: Effect.fn("CalendarConnector.createEvent")(function*(input, credential) {
          const token = yield* accessToken(createTool, credential)
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
          const event = yield* requestGoogleJson(
            createTool,
            CreatedCalendarEvent,
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: input.title,
                description: input.description ?? "",
                location: input.location ?? "",
                start: { dateTime: input.start, timeZone: timezone },
                end: { dateTime: input.end, timeZone: timezone },
              }),
            },
          )
          return { success: true as const, eventId: event.id, link: event.htmlLink, title: event.summary }
        }),
      }),
      defineConnectorTool({
        name: deleteTool,
        description: "Delete an event from Google Calendar.",
        parameters: {
          type: "object",
          properties: { eventId: { type: "string", description: "The event ID to delete" } },
          required: ["eventId"],
        },
        inputSchema: Schema.Struct({ eventId: Schema.String }),
        outputSchema: Schema.Struct({ success: Schema.Literal(true) }),
        run: Effect.fn("CalendarConnector.deleteEvent")(function*(input, credential) {
          const token = yield* accessToken(deleteTool, credential)
          yield* requestGoogleText(
            deleteTool,
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
          )
          return { success: true as const }
        }),
      }),
    ]
  }

  /** Returns a valid access token, refreshing the credential when required. */
  private getAccessToken(tool: string, credential: ConnectorCredential): Effect.Effect<string, ConnectorToolExecutionFailed> {
    if (credential.expiresAt > Date.now() + 60_000) return Effect.succeed(credential.accessToken)
    return Effect.tryPromise(() => this.refreshCredential(credential)).pipe(
      Effect.map((refreshed) => refreshed.accessToken),
      Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool, message: error.message })),
    )
  }
}
