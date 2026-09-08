import type { ConnectorCredential, ConnectorMetadata, ConnectorWithTools, ConnectorTool } from "../types.ts";
import { getGoogleAuthUrl, getGoogleConfig, refreshGoogleToken, revokeGoogleToken } from "./oauth.ts";
import { saveCredential, updateCredential, deleteCredential, getCredentialsForConnector } from "../store.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export class GmailConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: "gmail",
      name: "Gmail",
      description: "Read, send, and manage emails",
      icon: "gmail",
      scopes: SCOPES,
    };
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state);
  }

  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const tokenData = await import("./oauth.ts").then((m) => m.exchangeGoogleCode(config, code));
    return saveCredential({ ...tokenData, connectorId: "gmail" });
  }

  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken);
    const updated = await updateCredential(credential.id, { accessToken, expiresAt });
    if (!updated) throw new Error("Credential not found");
    return updated;
  }

  async revokeCredential(credentialId: string): Promise<void> {
    const creds = await getCredentialsForConnector("gmail");
    const cred = creds.find((c) => c.id === credentialId);
    if (cred) {
      await revokeGoogleToken(cred.accessToken);
    }
    await deleteCredential(credentialId);
  }

  tools(): ConnectorTool[] {
    return [
      {
        name: "gmail_list_messages",
        description: "List recent emails from Gmail. Returns subject, sender, date, and snippet.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query (e.g., 'is:unread', 'from:boss@company.com')" },
            maxResults: { type: "number", description: "Maximum number of messages to return (default 10)" },
          },
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const maxResults = (args.maxResults as number) ?? 10;
          const query = (args.query as string) ?? "";

          const listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!listRes.ok) throw new Error(`Gmail API error: ${listRes.status}`);
          const listData = await listRes.json() as { messages?: Array<{ id: string }> };
          const messages = listData.messages ?? [];

          const emails = await Promise.all(
            messages.slice(0, maxResults).map(async (msg) => {
              const res = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!res.ok) return null;
              const data = await res.json() as {
                id: string;
                snippet: string;
                payload?: { headers?: Array<{ name: string; value: string }> };
              };

              const headers = data.payload?.headers ?? [];
              const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

              return {
                id: data.id,
                subject: get("Subject"),
                from: get("From"),
                date: get("Date"),
                snippet: data.snippet,
              };
            })
          );

          return emails.filter(Boolean);
        },
      },
      {
        name: "gmail_send_email",
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
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const to = args.to as string;
          const subject = args.subject as string;
          const body = args.body as string;

          const message = [
            `To: ${to}`,
            `Subject: ${subject}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            body,
          ].join("\r\n");

          const encodedMessage = Buffer.from(message).toString("base64url");

          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw: encodedMessage }),
          });

          if (!res.ok) {
            const error = await res.text();
            throw new Error(`Failed to send email: ${error}`);
          }

          const data = await res.json() as { id: string; labelIds: string[] };
          return { success: true, messageId: data.id };
        },
      },
      {
        name: "gmail_search",
        description: "Search emails with a Gmail query and return full details.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query" },
            maxResults: { type: "number", description: "Maximum results (default 5)" },
          },
          required: ["query"],
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const query = args.query as string;
          const maxResults = (args.maxResults as number) ?? 5;

          const listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!listRes.ok) throw new Error(`Gmail API error: ${listRes.status}`);
          const listData = await listRes.json() as { messages?: Array<{ id: string }> };
          const messages = listData.messages ?? [];

          const emails = await Promise.all(
            messages.map(async (msg) => {
              const res = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!res.ok) return null;
              const data = await res.json() as {
                id: string;
                snippet: string;
                payload?: {
                  headers?: Array<{ name: string; value: string }>;
                  body?: { data?: string };
                  parts?: Array<{ mimeType: string; body?: { data?: string } }>;
                };
              };

              const headers = data.payload?.headers ?? [];
              const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

              let bodyContent = "";
              if (data.payload?.body?.data) {
                bodyContent = Buffer.from(data.payload.body.data, "base64url").toString("utf-8");
              } else if (data.payload?.parts) {
                const textPart = data.payload.parts.find((p) => p.mimeType === "text/plain");
                if (textPart?.body?.data) {
                  bodyContent = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
                }
              }

              return {
                id: data.id,
                subject: get("Subject"),
                from: get("From"),
                to: get("To"),
                date: get("Date"),
                body: bodyContent.slice(0, 2000),
                snippet: data.snippet,
              };
            })
          );

          return emails.filter(Boolean);
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
