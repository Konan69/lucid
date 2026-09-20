import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { ConnectionId } from '@vivid/contracts'
import { defineConnectionTool, type ConnectionMetadata, type ConnectionTool } from '../types.ts'
import { requestGoogleJson } from './request.ts'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
]
const LIST_TOOL = 'gmail_list_messages'
const SEND_TOOL = 'gmail_send_email'
const SEARCH_TOOL = 'gmail_search'

const MessageReference = Schema.Struct({ id: Schema.String })
const MessageListResponse = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(MessageReference)),
})
const Header = Schema.Struct({ name: Schema.String, value: Schema.String })
const MessagePart = Schema.Struct({
  mimeType: Schema.String,
  body: Schema.optionalKey(Schema.Struct({ data: Schema.optionalKey(Schema.String) })),
})
const MessagePayload = Schema.Struct({
  headers: Schema.optionalKey(Schema.Array(Header)),
  body: Schema.optionalKey(Schema.Struct({ data: Schema.optionalKey(Schema.String) })),
  parts: Schema.optionalKey(Schema.Array(MessagePart)),
})
const GmailMessage = Schema.Struct({
  id: Schema.String,
  snippet: Schema.String,
  payload: Schema.optionalKey(MessagePayload),
})
const EmailSummary = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  date: Schema.String,
  snippet: Schema.String,
})
const EmailDetails = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  to: Schema.String,
  date: Schema.String,
  body: Schema.String,
  snippet: Schema.String,
})
const SendResponse = Schema.Struct({ id: Schema.String, labelIds: Schema.Array(Schema.String) })

export const metadata: ConnectionMetadata = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Read, send, and manage emails',
  icon: 'gmail',
  scopes: SCOPES,
}

const headerValue = (headers: ReadonlyArray<typeof Header.Type>, name: string) => {
  const header = headers.find((candidate) => candidate.name === name)
  return header === undefined ? '' : header.value
}

const messageBody = (payload: Option.Option<typeof MessagePayload.Type>) => {
  if (Option.isNone(payload)) return ''
  const body = payload.value.body
  if (body !== undefined && body.data !== undefined)
    return Buffer.from(body.data, 'base64url').toString('utf-8')
  const parts = payload.value.parts
  if (parts === undefined) return ''
  const textPart = parts.find((part) => part.mimeType === 'text/plain')
  if (textPart === undefined || textPart.body === undefined || textPart.body.data === undefined)
    return ''
  return Buffer.from(textPart.body.data, 'base64url').toString('utf-8')
}

const headersOf = (message: typeof GmailMessage.Type) =>
  message.payload === undefined || message.payload.headers === undefined
    ? []
    : message.payload.headers

/** Lists recent Gmail messages and projects provider payloads into bounded model JSON. */
const listMessages = defineConnectionTool({
  name: LIST_TOOL,
  description: 'List recent emails from Gmail. Returns subject, sender, date, and snippet.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Gmail search query (e.g., 'is:unread')" },
      maxResults: {
        type: 'number',
        description: 'Maximum number of messages to return (default 10)',
      },
    },
  },
  inputSchema: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    maxResults: Schema.optionalKey(Schema.Number),
  }),
  outputSchema: Schema.Array(EmailSummary),
  run: Effect.fn('Connection.Gmail.listMessages')(function* (input, accessToken) {
    const query = input.query === undefined ? '' : input.query
    const maxResults = input.maxResults === undefined ? 10 : input.maxResults
    const list = yield* requestGoogleJson(
      LIST_TOOL,
      MessageListResponse,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const messages = list.messages === undefined ? [] : list.messages
    const candidates = yield* Effect.forEach(
      messages.slice(0, maxResults),
      (message) =>
        requestGoogleJson(
          LIST_TOOL,
          GmailMessage,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).pipe(Effect.option),
      { concurrency: 'unbounded' },
    )
    return candidates.filter(Option.isSome).map(({ value: data }) => {
      const headers = headersOf(data)
      return {
        id: data.id,
        subject: headerValue(headers, 'Subject'),
        from: headerValue(headers, 'From'),
        date: headerValue(headers, 'Date'),
        snippet: data.snippet,
      }
    })
  }),
})

/** Sends one plain-text Gmail message after the runtime explicitly asks for the action. */
const sendEmail = defineConnectionTool({
  name: SEND_TOOL,
  description: 'Send an email via Gmail.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text)' },
    },
    required: ['to', 'subject', 'body'],
  },
  inputSchema: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  outputSchema: Schema.Struct({ success: Schema.Literal(true), messageId: Schema.String }),
  run: Effect.fn('Connection.Gmail.sendEmail')(function* (input, accessToken) {
    const message = [
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      input.body,
    ].join('\r\n')
    const data = yield* requestGoogleJson(
      SEND_TOOL,
      SendResponse,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') }),
      },
    )
    return { success: true as const, messageId: data.id }
  }),
})

/** Searches Gmail and returns full message details with a bounded plain-text body. */
const searchMessages = defineConnectionTool({
  name: SEARCH_TOOL,
  description: 'Search emails with a Gmail query and return full details.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query' },
      maxResults: { type: 'number', description: 'Maximum results (default 5)' },
    },
    required: ['query'],
  },
  inputSchema: Schema.Struct({
    query: Schema.String,
    maxResults: Schema.optionalKey(Schema.Number),
  }),
  outputSchema: Schema.Array(EmailDetails),
  run: Effect.fn('Connection.Gmail.searchMessages')(function* (input, accessToken) {
    const maxResults = input.maxResults === undefined ? 5 : input.maxResults
    const list = yield* requestGoogleJson(
      SEARCH_TOOL,
      MessageListResponse,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(input.query)}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const messages = list.messages === undefined ? [] : list.messages
    const candidates = yield* Effect.forEach(
      messages.slice(0, maxResults),
      (message) =>
        requestGoogleJson(
          SEARCH_TOOL,
          GmailMessage,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).pipe(Effect.option),
      { concurrency: 'unbounded' },
    )
    return candidates.filter(Option.isSome).map(({ value: data }) => {
      const headers = headersOf(data)
      return {
        id: data.id,
        subject: headerValue(headers, 'Subject'),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        date: headerValue(headers, 'Date'),
        body: messageBody(Option.fromNullishOr(data.payload)).slice(0, 2_000),
        snippet: data.snippet,
      }
    })
  }),
})

export const tools: ReadonlyArray<ConnectionTool> = [listMessages, sendEmail, searchMessages]
export const connectionId: ConnectionId = 'gmail'
