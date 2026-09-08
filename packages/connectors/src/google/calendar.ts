import type { ConnectorCredential, ConnectorMetadata, ConnectorWithTools, ConnectorTool } from "../types.ts";
import { getGoogleAuthUrl, getGoogleConfig, refreshGoogleToken, revokeGoogleToken } from "./oauth.ts";
import { saveCredential, updateCredential, deleteCredential, getCredentialsForConnector } from "../store.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export class CalendarConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: "calendar",
      name: "Google Calendar",
      description: "View and create calendar events",
      icon: "calendar",
      scopes: SCOPES,
    };
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state);
  }

  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const tokenData = await import("./oauth.ts").then((m) => m.exchangeGoogleCode(config, code));
    return saveCredential({ ...tokenData, connectorId: "calendar" });
  }

  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken);
    const updated = await updateCredential(credential.id, { accessToken, expiresAt });
    if (!updated) throw new Error("Credential not found");
    return updated;
  }

  async revokeCredential(credentialId: string): Promise<void> {
    const creds = await getCredentialsForConnector("calendar");
    const cred = creds.find((c) => c.id === credentialId);
    if (cred) await revokeGoogleToken(cred.accessToken);
    await deleteCredential(credentialId);
  }

  tools(): ConnectorTool[] {
    return [
      {
        name: "calendar_list_events",
        description: "List upcoming calendar events from Google Calendar.",
        parameters: {
          type: "object",
          properties: {
            timeMin: { type: "string", description: "Start of time range (ISO 8601, default: now)" },
            timeMax: { type: "string", description: "End of time range (ISO 8601, default: 7 days from now)" },
            maxResults: { type: "number", description: "Maximum events to return (default 10)" },
          },
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const timeMin = (args.timeMin as string) ?? new Date().toISOString();
          const timeMax = (args.timeMax as string) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const maxResults = (args.maxResults as number) ?? 10;

          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
          const data = await res.json() as { items?: Array<{
            id: string;
            summary: string;
            description?: string;
            location?: string;
            start: { dateTime?: string; date?: string };
            end: { dateTime?: string; date?: string };
            htmlLink: string;
          }> };

          return (data.items ?? []).map((event) => ({
            id: event.id,
            title: event.summary,
            description: event.description ?? "",
            location: event.location ?? "",
            start: event.start.dateTime ?? event.start.date ?? "",
            end: event.end.dateTime ?? event.end.date ?? "",
            link: event.htmlLink,
          }));
        },
      },
      {
        name: "calendar_create_event",
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
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);

          const res = await fetch(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                summary: args.title,
                description: args.description ?? "",
                location: args.location ?? "",
                start: { dateTime: args.start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
                end: { dateTime: args.end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              }),
            }
          );

          if (!res.ok) {
            const error = await res.text();
            throw new Error(`Failed to create event: ${error}`);
          }

          const event = await res.json() as { id: string; htmlLink: string; summary: string };
          return { success: true, eventId: event.id, link: event.htmlLink, title: event.summary };
        },
      },
      {
        name: "calendar_delete_event",
        description: "Delete an event from Google Calendar.",
        parameters: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID to delete" },
          },
          required: ["eventId"],
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${args.eventId}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
          );

          if (!res.ok) throw new Error(`Failed to delete event: ${res.status}`);
          return { success: true };
        },
      },
    ];
  }

  private async getAccessToken(credential: ConnectorCredential): Promise<string> {
    if (credential.expiresAt > Date.now() + 60_000) {
      return credential.accessToken;
    }
    const refreshed = await this.refreshCredential(credential);
    return refreshed.accessToken;
  }
}
