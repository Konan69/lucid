import type { ConnectorCredential, ConnectorMetadata, ConnectorWithTools, ConnectorTool } from "../types.ts";
import { getGoogleAuthUrl, getGoogleConfig, refreshGoogleToken, revokeGoogleToken } from "./oauth.ts";
import { saveCredential, updateCredential, deleteCredential, getCredentialsForConnector } from "../store.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

export class DriveConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: "drive",
      name: "Google Drive",
      description: "Search, read, and upload files from Google Drive",
      icon: "drive",
      scopes: SCOPES,
    };
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state);
  }

  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const tokenData = await import("./oauth.ts").then((m) => m.exchangeGoogleCode(config, code));
    return saveCredential({ ...tokenData, connectorId: "drive" });
  }

  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig();
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken);
    const updated = await updateCredential(credential.id, { accessToken, expiresAt });
    if (!updated) throw new Error("Credential not found");
    return updated;
  }

  async revokeCredential(credentialId: string): Promise<void> {
    const creds = await getCredentialsForConnector("drive");
    const cred = creds.find((c) => c.id === credentialId);
    if (cred) await revokeGoogleToken(cred.accessToken);
    await deleteCredential(credentialId);
  }

  tools(): ConnectorTool[] {
    return [
      {
        name: "drive_search",
        description: "Search for files in Google Drive.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (e.g., 'name contains \"report\"', 'mimeType = \"application/pdf\"')" },
            maxResults: { type: "number", description: "Maximum files to return (default 10)" },
          },
          required: ["query"],
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const query = args.query as string;
          const maxResults = (args.maxResults as number) ?? 10;

          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=${maxResults}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink,parents)`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
          const data = await res.json() as { files?: Array<{
            id: string;
            name: string;
            mimeType: string;
            size?: string;
            modifiedTime: string;
            webViewLink?: string;
            parents?: string[];
          }> };

          return (data.files ?? []).map((file) => ({
            id: file.id,
            name: file.name,
            type: file.mimeType,
            size: file.size ? parseInt(file.size) : null,
            modified: file.modifiedTime,
            link: file.webViewLink ?? "",
          }));
        },
      },
      {
        name: "drive_read_file",
        description: "Read the content of a text file from Google Drive.",
        parameters: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "The Google Drive file ID" },
          },
          required: ["fileId"],
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const fileId = args.fileId as string;

          const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!metaRes.ok) throw new Error(`Failed to get file metadata: ${metaRes.status}`);
          const meta = await metaRes.json() as { name: string; mimeType: string; size?: string };

          if (meta.mimeType === "application/vnd.google-apps.folder") {
            return { error: "Cannot read folder contents as text" };
          }

          const isGoogleDoc = meta.mimeType.startsWith("application/vnd.google-apps.");
          let content: string;

          if (isGoogleDoc) {
            const exportRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!exportRes.ok) throw new Error(`Failed to export file: ${exportRes.status}`);
            content = await exportRes.text();
          } else {
            const res = await fetch(
              `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
            content = await res.text();
          }

          return {
            name: meta.name,
            mimeType: meta.mimeType,
            content: content.slice(0, 100_000),
          };
        },
      },
      {
        name: "drive_list_recent",
        description: "List recently modified files in Google Drive.",
        parameters: {
          type: "object",
          properties: {
            maxResults: { type: "number", description: "Maximum files to return (default 10)" },
          },
        },
        execute: async (args, credential) => {
          const token = await this.getAccessToken(credential);
          const maxResults = (args.maxResults as number) ?? 10;

          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
          const data = await res.json() as { files?: Array<{
            id: string;
            name: string;
            mimeType: string;
            size?: string;
            modifiedTime: string;
            webViewLink?: string;
          }> };

          return (data.files ?? []).map((file) => ({
            id: file.id,
            name: file.name,
            type: file.mimeType,
            size: file.size ? parseInt(file.size) : null,
            modified: file.modifiedTime,
            link: file.webViewLink ?? "",
          }));
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
