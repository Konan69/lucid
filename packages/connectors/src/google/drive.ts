import { Effect, Schema } from 'effect'
import type {
  ConnectorCredential,
  ConnectorMetadata,
  ConnectorTool,
  ConnectorWithTools,
} from '../types.ts'
import { ConnectorToolExecutionFailed, defineConnectorTool } from '../types.ts'
import {
  getGoogleAuthUrl,
  getGoogleConfig,
  refreshGoogleToken,
  revokeGoogleToken,
} from './oauth.ts'
import {
  saveCredential,
  updateCredential,
  deleteCredential,
  getCredentialsForConnector,
} from '../store.ts'
import { requestGoogleJson, requestGoogleText } from './request.ts'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
]

const DriveFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.optionalKey(Schema.String),
  modifiedTime: Schema.String,
  webViewLink: Schema.optionalKey(Schema.String),
  parents: Schema.optionalKey(Schema.Array(Schema.String)),
})
const DriveFileList = Schema.Struct({ files: Schema.optionalKey(Schema.Array(DriveFile)) })
const DriveFileMetadata = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.optionalKey(Schema.String),
})
const DriveFileSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  size: Schema.NullOr(Schema.Number),
  modified: Schema.String,
  link: Schema.String,
})
const DriveReadResult = Schema.Union([
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ name: Schema.String, mimeType: Schema.String, content: Schema.String }),
])

/** Projects a decoded Google Drive file into Vivid's bounded tool result. */
const summarizeFile = (file: typeof DriveFile.Type): typeof DriveFileSummary.Type => ({
  id: file.id,
  name: file.name,
  type: file.mimeType,
  size: file.size === undefined ? null : Number.parseInt(file.size, 10),
  modified: file.modifiedTime,
  link: file.webViewLink ?? '',
})

export class DriveConnector implements ConnectorWithTools {
  metadata(): ConnectorMetadata {
    return {
      id: 'drive',
      name: 'Google Drive',
      description: 'Search, read, and upload files from Google Drive',
      icon: 'drive',
      scopes: SCOPES,
    }
  }

  getAuthUrl(state: string): string {
    return getGoogleAuthUrl(getGoogleConfig(), SCOPES, state)
  }

  /** Exchanges an OAuth grant and persists the resulting Drive credential. */
  async exchangeCode(code: string): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const tokenData = await import('./oauth.ts').then((module) =>
      module.exchangeGoogleCode(config, code),
    )
    return saveCredential({ ...tokenData, connectorId: 'drive' })
  }

  /** Refreshes and persists an expired Drive credential. */
  async refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential> {
    const config = getGoogleConfig()
    const { accessToken, expiresAt } = await refreshGoogleToken(config, credential.refreshToken)
    const updated = await updateCredential(credential.id, { accessToken, expiresAt })
    if (updated === null) throw new Error('Credential not found')
    return updated
  }

  /** Revokes a Drive grant before deleting its local credential. */
  async revokeCredential(credentialId: string): Promise<void> {
    const credentials = await getCredentialsForConnector('drive')
    const credential = credentials.find((candidate) => candidate.id === credentialId)
    if (credential !== undefined) await revokeGoogleToken(credential.accessToken)
    await deleteCredential(credentialId)
  }

  /** Returns Drive tools with owned input and output schemas. */
  tools(): ReadonlyArray<ConnectorTool> {
    const searchTool = 'drive_search'
    const readTool = 'drive_read_file'
    const recentTool = 'drive_list_recent'
    const accessToken = (tool: string, credential: ConnectorCredential) =>
      this.getAccessToken(tool, credential)
    return [
      defineConnectorTool({
        name: searchTool,
        description: 'Search for files in Google Drive.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Search query (e.g., \'name contains "report"\', \'mimeType = "application/pdf"\')',
            },
            maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
          },
          required: ['query'],
        },
        inputSchema: Schema.Struct({
          query: Schema.String,
          maxResults: Schema.optionalKey(Schema.Number),
        }),
        outputSchema: Schema.Array(DriveFileSummary),
        run: Effect.fn('DriveConnector.searchFiles')(function* (input, credential) {
          const token = yield* accessToken(searchTool, credential)
          const maxResults = input.maxResults ?? 10
          const data = yield* requestGoogleJson(
            searchTool,
            DriveFileList,
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(input.query)}&pageSize=${maxResults}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink,parents)`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          return (data.files ?? []).map(summarizeFile)
        }),
      }),
      defineConnectorTool({
        name: readTool,
        description: 'Read the content of a text file from Google Drive.',
        parameters: {
          type: 'object',
          properties: { fileId: { type: 'string', description: 'The Google Drive file ID' } },
          required: ['fileId'],
        },
        inputSchema: Schema.Struct({ fileId: Schema.String }),
        outputSchema: DriveReadResult,
        run: Effect.fn('DriveConnector.readFile')(function* (input, credential) {
          const token = yield* accessToken(readTool, credential)
          const fileId = encodeURIComponent(input.fileId)
          const metadata = yield* requestGoogleJson(
            readTool,
            DriveFileMetadata,
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          if (metadata.mimeType === 'application/vnd.google-apps.folder') {
            return { error: 'Cannot read folder contents as text' }
          }
          const url = metadata.mimeType.startsWith('application/vnd.google-apps.')
            ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
            : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
          const content = yield* requestGoogleText(readTool, url, {
            headers: { Authorization: `Bearer ${token}` },
          })
          return {
            name: metadata.name,
            mimeType: metadata.mimeType,
            content: content.slice(0, 100_000),
          }
        }),
      }),
      defineConnectorTool({
        name: recentTool,
        description: 'List recently modified files in Google Drive.',
        parameters: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
          },
        },
        inputSchema: Schema.Struct({ maxResults: Schema.optionalKey(Schema.Number) }),
        outputSchema: Schema.Array(DriveFileSummary),
        run: Effect.fn('DriveConnector.listRecentFiles')(function* (input, credential) {
          const token = yield* accessToken(recentTool, credential)
          const maxResults = input.maxResults ?? 10
          const data = yield* requestGoogleJson(
            recentTool,
            DriveFileList,
            `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          return (data.files ?? []).map(summarizeFile)
        }),
      }),
    ]
  }

  /** Returns a valid access token, refreshing the credential when required. */
  private getAccessToken(
    tool: string,
    credential: ConnectorCredential,
  ): Effect.Effect<string, ConnectorToolExecutionFailed> {
    if (credential.expiresAt > Date.now() + 60_000) return Effect.succeed(credential.accessToken)
    return Effect.tryPromise(() => this.refreshCredential(credential)).pipe(
      Effect.map((refreshed) => refreshed.accessToken),
      Effect.mapError(
        (error) => new ConnectorToolExecutionFailed({ tool, message: error.message }),
      ),
    )
  }
}
