import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { ConnectionId } from '@vivid/contracts'
import { defineConnectionTool, type ConnectionMetadata, type ConnectionTool } from '../types.ts'
import { requestGoogleJson, requestGoogleText } from './request.ts'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
]
const SEARCH_TOOL = 'drive_search'
const READ_TOOL = 'drive_read_file'
const RECENT_TOOL = 'drive_list_recent'

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

export const metadata: ConnectionMetadata = {
  id: 'drive',
  name: 'Google Drive',
  description: 'Search, read, and upload files from Google Drive',
  icon: 'drive',
  scopes: SCOPES,
}

const summarizeFile = (file: typeof DriveFile.Type): typeof DriveFileSummary.Type => ({
  id: file.id,
  name: file.name,
  type: file.mimeType,
  size: file.size === undefined ? null : Number.parseInt(file.size, 10),
  modified: file.modifiedTime,
  link: file.webViewLink === undefined ? '' : file.webViewLink,
})

/** Searches Drive's file index and returns a bounded summary for the model. */
const searchFiles = defineConnectionTool({
  name: SEARCH_TOOL,
  description: 'Search for files in Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Google Drive search query' },
      maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
    },
    required: ['query'],
  },
  inputSchema: Schema.Struct({
    query: Schema.String,
    maxResults: Schema.optionalKey(Schema.Number),
  }),
  outputSchema: Schema.Array(DriveFileSummary),
  run: Effect.fn('Connection.Drive.searchFiles')(function* (input, accessToken) {
    const maxResults = input.maxResults === undefined ? 10 : input.maxResults
    const data = yield* requestGoogleJson(
      SEARCH_TOOL,
      DriveFileList,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(input.query)}&pageSize=${maxResults}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink,parents)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const files = data.files === undefined ? [] : data.files
    return files.map(summarizeFile)
  }),
})

/** Reads a Drive text file, exporting Google-native documents as plain text. */
const readFile = defineConnectionTool({
  name: READ_TOOL,
  description: 'Read the content of a text file from Google Drive.',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string', description: 'The Google Drive file ID' } },
    required: ['fileId'],
  },
  inputSchema: Schema.Struct({ fileId: Schema.String }),
  outputSchema: DriveReadResult,
  run: Effect.fn('Connection.Drive.readFile')(function* (input, accessToken) {
    const fileId = encodeURIComponent(input.fileId)
    const fileMetadata = yield* requestGoogleJson(
      READ_TOOL,
      DriveFileMetadata,
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (fileMetadata.mimeType === 'application/vnd.google-apps.folder')
      return { error: 'Cannot read folder contents as text' }
    const url = fileMetadata.mimeType.startsWith('application/vnd.google-apps.')
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    const content = yield* requestGoogleText(READ_TOOL, url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return {
      name: fileMetadata.name,
      mimeType: fileMetadata.mimeType,
      content: content.slice(0, 100_000),
    }
  }),
})

/** Lists Drive files ordered by the provider's modification timestamp. */
const listRecentFiles = defineConnectionTool({
  name: RECENT_TOOL,
  description: 'List recently modified files in Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: { type: 'number', description: 'Maximum files to return (default 10)' },
    },
  },
  inputSchema: Schema.Struct({ maxResults: Schema.optionalKey(Schema.Number) }),
  outputSchema: Schema.Array(DriveFileSummary),
  run: Effect.fn('Connection.Drive.listRecentFiles')(function* (input, accessToken) {
    const maxResults = input.maxResults === undefined ? 10 : input.maxResults
    const data = yield* requestGoogleJson(
      RECENT_TOOL,
      DriveFileList,
      `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const files = data.files === undefined ? [] : data.files
    return files.map(summarizeFile)
  }),
})

export const tools: ReadonlyArray<ConnectionTool> = [searchFiles, readFile, listRecentFiles]
export const connectionId: ConnectionId = 'drive'
