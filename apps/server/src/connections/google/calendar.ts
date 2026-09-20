import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { ConnectionId } from '@vivid/contracts'
import { defineConnectionTool, type ConnectionMetadata, type ConnectionTool } from '../types.ts'
import { requestGoogleJson, requestGoogleText } from './request.ts'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]
const LIST_TOOL = 'calendar_list_events'
const CREATE_TOOL = 'calendar_create_event'
const DELETE_TOOL = 'calendar_delete_event'

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
const CreatedCalendarEvent = Schema.Struct({
  id: Schema.String,
  htmlLink: Schema.String,
  summary: Schema.String,
})

export const metadata: ConnectionMetadata = {
  id: 'calendar',
  name: 'Google Calendar',
  description: 'View and create calendar events',
  icon: 'calendar',
  scopes: SCOPES,
}

const calendarDate = (value: typeof CalendarDate.Type) => {
  if (value.dateTime !== undefined) return value.dateTime
  if (value.date !== undefined) return value.date
  return ''
}

/** Lists upcoming Calendar events in the bounded shape used by the model tool. */
const listEvents = defineConnectionTool({
  name: LIST_TOOL,
  description: 'List upcoming calendar events from Google Calendar.',
  parameters: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'Start of time range (ISO 8601, default: now)' },
      timeMax: {
        type: 'string',
        description: 'End of time range (ISO 8601, default: 7 days from now)',
      },
      maxResults: { type: 'number', description: 'Maximum events to return (default 10)' },
    },
  },
  inputSchema: Schema.Struct({
    timeMin: Schema.optionalKey(Schema.String),
    timeMax: Schema.optionalKey(Schema.String),
    maxResults: Schema.optionalKey(Schema.Number),
  }),
  outputSchema: Schema.Array(CalendarEventOutput),
  run: Effect.fn('Connection.Calendar.listEvents')(function* (input, accessToken) {
    const timeMin = input.timeMin === undefined ? new Date().toISOString() : input.timeMin
    const timeMax =
      input.timeMax === undefined
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
        : input.timeMax
    const maxResults = input.maxResults === undefined ? 10 : input.maxResults
    const data = yield* requestGoogleJson(
      LIST_TOOL,
      CalendarEventList,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const items = data.items === undefined ? [] : data.items
    return items.map((event) => ({
      id: event.id,
      title: event.summary,
      description: event.description === undefined ? '' : event.description,
      location: event.location === undefined ? '' : event.location,
      start: calendarDate(event.start),
      end: calendarDate(event.end),
      link: event.htmlLink,
    }))
  }),
})

/** Creates a Calendar event with the user's local timezone attached to the event times. */
const createEvent = defineConnectionTool({
  name: CREATE_TOOL,
  description: 'Create a new event on Google Calendar.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time (ISO 8601)' },
      end: { type: 'string', description: 'End time (ISO 8601)' },
      description: { type: 'string', description: 'Event description' },
      location: { type: 'string', description: 'Event location' },
    },
    required: ['title', 'start', 'end'],
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
  run: Effect.fn('Connection.Calendar.createEvent')(function* (input, accessToken) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const event = yield* requestGoogleJson(
      CREATE_TOOL,
      CreatedCalendarEvent,
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: input.title,
          description: input.description === undefined ? '' : input.description,
          location: input.location === undefined ? '' : input.location,
          start: { dateTime: input.start, timeZone: timezone },
          end: { dateTime: input.end, timeZone: timezone },
        }),
      },
    )
    return { success: true as const, eventId: event.id, link: event.htmlLink, title: event.summary }
  }),
})

/** Deletes the requested event and returns an explicit action receipt. */
const deleteEvent = defineConnectionTool({
  name: DELETE_TOOL,
  description: 'Delete an event from Google Calendar.',
  parameters: {
    type: 'object',
    properties: { eventId: { type: 'string', description: 'The event ID to delete' } },
    required: ['eventId'],
  },
  inputSchema: Schema.Struct({ eventId: Schema.String }),
  outputSchema: Schema.Struct({ success: Schema.Literal(true) }),
  run: Effect.fn('Connection.Calendar.deleteEvent')(function* (input, accessToken) {
    yield* requestGoogleText(
      DELETE_TOOL,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    )
    return { success: true as const }
  }),
})

export const tools: ReadonlyArray<ConnectionTool> = [listEvents, createEvent, deleteEvent]
export const connectionId: ConnectionId = 'calendar'
