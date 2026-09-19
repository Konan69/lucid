import { Effect, Option, Schema } from "effect"
import type { ConnectorCredential, ConnectorMetadata, ConnectorTool, ConnectorWithTools } from "../types.ts"
import { ConnectorToolExecutionFailed, defineConnectorTool } from "../types.ts"
import { getGoogleAuthUrl, getGoogleConfig, refreshGoogleToken, revokeGoogleToken } from "./oauth.ts"
import { saveCredential, updateCredential, deleteCredential, getCredentialsForConnector } from "../store.ts"
import { requestGoogleJson } from "./request.ts"

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
]

const MessageReference = Schema.Struct({ id: Schema.String })
const MessageListResponse = Schema.Struct({ messages: Schema.optionalKey(Schema.Array(MessageReference)) })
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

/** Finds one case-sensitive Gmail metadata header without widening missing values. */
const headerValue = (headers: ReadonlyArray<typeof Header.Type>, name: string): string => {
  const header = headers.find((candidate) => candidate.name === name)
  return header === undefined ? "" : header.value
}

/** Decodes the first plain-text body carried by a Gmail message payload. */
const messageBody = (payload: typeof MessagePayload.Type | undefined): string => {
  if (payload === undefined) return ""
  if (payload.body !== undefined && payload.body.data !== undefined) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8")
  }
  if (payload.parts === undefined) return ""
  const textPart = payload.parts.find((part) => part.mimeType === "text/plain")
  if (textPart === undefined || textPart.body === undefined || textPart.body.data === undefined) return ""
  return Buffer.from(textPart.body.data, "base64url").toString("utf-8")
}

export class GmailConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: "gmail",
      name: "Gmail",
      description: "Read, send, and manage emails",
      icon: "gmail",
      scopes: SCOPES,
    }
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state)
  }

  /** Exchanges an OAuth grant and persists the resulting Gmail credential. */
  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const tokenData = await import("./oauth.ts").then((module) => module.exchangeGoogleCode(config, code))
    return saveCredential({ ...tokenData, connectorId: "gmail" })
  }

  /** Refreshes and persists an expired Gmail credential. */
  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken)
    const updated = await updateCredential(credential.id, { accessToken, expiresAt })
    if (updated === null) throw new Error("Credential not found")
    return updated
  }

  /** Revokes a Gmail grant before deleting its local credential. */
  async revokeCredential(credentialId: string): Promise<void> {
    const credentials = await getCredentialsForConnector("gmail")
    const credential = credentials.find((candidate) => candidate.id === credentialId)
    if (credential !== undefined) {
      await revokeGoogleToken(credential.accessToken)
    }
    await deleteCredential(credentialId)
  }

  /** Returns Gmail tools with owned input and output schemas. */
  tools(): ReadonlyArray<ConnectorTool> {
    const listTool = "gmail_list_messages"
    const sendTool = "gmail_send_email"
    const searchTool = "gmail_search"
    const accessToken = (tool: string, credential: ConnectorCredential) => this.getAccessToken(tool, credential)
    return [
      defineConnectorTool({
        name: listTool,
        description: "List recent emails from Gmail. Returns subject, sender, date, and snippet.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query (e.g., 'is:unread', 'from:boss@company.com')" },
            maxResults: { type: "number", description: "Maximum number of messages to return (default 10)" },
          },
        },
        inputSchema: Schema.Struct({
          query: Schema.optionalKey(Schema.String),
          maxResults: Schema.optionalKey(Schema.Number),
        }),
        outputSchema: Schema.Array(EmailSummary),
        run: Effect.fn("GmailConnector.listMessages")(function*(input, credential) {
          const token = yield* accessToken(listTool, credential)
          const maxResults = input.maxResults ?? 10
          const query = input.query ?? ""
          const list = yield* requestGoogleJson(
            listTool,
            MessageListResponse,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          const messages = list.messages ?? []
          const candidates = yield* Effect.forEach(messages.slice(0, maxResults), (message) => requestGoogleJson(
            listTool,
            GmailMessage,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` } },
          ).pipe(Effect.option), { concurrency: "unbounded" })
          return candidates.filter(Option.isSome).map(({ value: data }) => {
            const headers = data.payload === undefined || data.payload.headers === undefined ? [] : data.payload.headers
            return {
              id: data.id,
              subject: headerValue(headers, "Subject"),
              from: headerValue(headers, "From"),
              date: headerValue(headers, "Date"),
              snippet: data.snippet,
            }
          })
        }),
      }),
      defineConnectorTool({
        name: sendTool,
        description: "Send an email via Gmail.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address" },
            subject: { type: "string", description: "Email subject" },
            body: { type: "string", description: "Email body (plain text)" },
          },
          required: ["to", "subject", "body"],
        },
        inputSchema: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
        outputSchema: Schema.Struct({ success: Schema.Literal(true), messageId: Schema.String }),
        run: Effect.fn("GmailConnector.sendEmail")(function*(input, credential) {
          const token = yield* accessToken(sendTool, credential)
          const message = [
            `To: ${input.to}`,
            `Subject: ${input.subject}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            input.body,
          ].join("\r\n")
          const data = yield* requestGoogleJson(
            sendTool,
            SendResponse,
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ raw: Buffer.from(message).toString("base64url") }),
            },
          )
          return { success: true as const, messageId: data.id }
        }),
      }),
      defineConnectorTool({
        name: searchTool,
        description: "Search emails with a Gmail query and return full details.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query" },
            maxResults: { type: "number", description: "Maximum results (default 5)" },
          },
          required: ["query"],
        },
        inputSchema: Schema.Struct({ query: Schema.String, maxResults: Schema.optionalKey(Schema.Number) }),
        outputSchema: Schema.Array(EmailDetails),
        run: Effect.fn("GmailConnector.searchMessages")(function*(input, credential) {
          const token = yield* accessToken(searchTool, credential)
          const maxResults = input.maxResults ?? 5
          const list = yield* requestGoogleJson(
            searchTool,
            MessageListResponse,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(input.query)}&maxResults=${maxResults}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          const candidates = yield* Effect.forEach(list.messages ?? [], (message) => requestGoogleJson(
            searchTool,
            GmailMessage,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
            { headers: { Authorization: `Bearer ${token}` } },
          ).pipe(Effect.option), { concurrency: "unbounded" })
          return candidates.filter(Option.isSome).map(({ value: data }) => {
            const headers = data.payload === undefined || data.payload.headers === undefined ? [] : data.payload.headers
            return {
              id: data.id,
              subject: headerValue(headers, "Subject"),
              from: headerValue(headers, "From"),
              to: headerValue(headers, "To"),
              date: headerValue(headers, "Date"),
              body: messageBody(data.payload).slice(0, 2_000),
              snippet: data.snippet,
            }
          })
        }),
      }),
    ]
  }

  /** Returns a valid access token, refreshing the credential when required. */
  private getAccessToken(tool: string, credential: ConnectorCredential): Effect.Effect<string, ConnectorToolExecutionFailed> {
    if (credential.expiresAt > Date.now() + 60_000) {
      return Effect.succeed(credential.accessToken)
    }
    return Effect.tryPromise(() => this.refreshCredential(credential)).pipe(
      Effect.map((refreshed) => refreshed.accessToken),
      Effect.mapError((error) => new ConnectorToolExecutionFailed({ tool, message: error.message })),
    )
  }
}
