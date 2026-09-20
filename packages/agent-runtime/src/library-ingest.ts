import * as NodeCrypto from 'node:crypto'
import { Effect, Schema } from 'effect'
import { extractText } from 'unpdf'
import {
  completeLibraryDocument,
  failLibraryDocument,
  getStoredLibraryDocument,
  type IndexedChunk,
} from './library-store.ts'

const MAX_CHUNK_CHARACTERS = 1_400
const CHUNK_OVERLAP_CHARACTERS = 180

export const MAX_LIBRARY_FILE_BYTES = 10 * 1024 * 1024
export const LIBRARY_FILE_TYPES = ['application/pdf', 'text/markdown', 'text/plain'] as const

export function digestBytes(bytes: Uint8Array) {
  return NodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function chunkText(text: string, page: number | null): IndexedChunk[] {
  const normalized = normalizeText(text)
  if (!normalized) return []
  const chunks: IndexedChunk[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + MAX_CHUNK_CHARACTERS, normalized.length)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end))
      if (boundary > start + MAX_CHUNK_CHARACTERS / 2) end = boundary
    }
    const chunk = normalized.slice(start, end).trim()
    if (chunk) chunks.push({ page, text: chunk })
    if (end >= normalized.length) break
    start = Math.max(end - CHUNK_OVERLAP_CHARACTERS, start + 1)
  }
  return chunks
}

async function extractPages(name: string, mimeType: string, bytes: Uint8Array) {
  const pdf = mimeType === 'application/pdf' || name.toLocaleLowerCase().endsWith('.pdf')
  if (pdf) {
    const result = await extractText(bytes, { mergePages: false })
    const pages = Array.isArray(result.text) ? result.text : [result.text]
    return pages.map((text, index) => ({ page: index + 1, text: normalizeText(text) }))
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return [{ page: null, text: normalizeText(text) }]
}

class LibraryIngestFailure extends Schema.TaggedError<LibraryIngestFailure>()(
  'LibraryIngestFailure',
  { message: Schema.String },
  { title: 'Library ingest failure' },
) {}

const loadDocument = Effect.fn('LibraryIngest.loadDocument')(function* (id: string) {
  const document = yield* Effect.tryPromise({
    try: () => getStoredLibraryDocument(id),
    catch: () => new LibraryIngestFailure({ message: 'Library document could not be loaded' }),
  })
  return yield* document === null
    ? Effect.fail(new LibraryIngestFailure({ message: 'Library document not found' }))
    : Effect.succeed(document)
})

const extractDocumentPages = Effect.fn('LibraryIngest.extractPages')(function* (
  document: NonNullable<Awaited<ReturnType<typeof getStoredLibraryDocument>>>,
) {
  return yield* Effect.tryPromise({
    try: () => extractPages(document.name, document.mimeType, document.bytes),
    catch: (error) =>
      new LibraryIngestFailure({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
})

const indexDocument = Effect.fn('LibraryIngest.indexDocument')(function* (id: string) {
  const document = yield* loadDocument(id)
  const pages = yield* extractDocumentPages(document)
  const extractedText = pages
    .map((page) => page.text)
    .filter(Boolean)
    .join('\n\n')
  if (extractedText.length === 0) {
    return yield* Effect.fail(
      new LibraryIngestFailure({ message: 'No readable text was found in this document' }),
    )
  }
  const chunks = pages.flatMap((page) => chunkText(page.text, page.page))
  if (chunks.length === 0) {
    return yield* Effect.fail(
      new LibraryIngestFailure({ message: 'No searchable text was found in this document' }),
    )
  }
  return yield* Effect.tryPromise({
    try: () => completeLibraryDocument(id, extractedText, chunks),
    catch: () => new LibraryIngestFailure({ message: 'Library index could not be saved' }),
  })
})

/** Extracts and persists one document while recording expected ingest failures on the document. */
export const ingestLibraryDocument = Effect.fn('LibraryIngest.ingestDocument')(function* (
  id: string,
) {
  return yield* indexDocument(id).pipe(
    Effect.catch((failure) =>
      Effect.tryPromise({
        try: () => failLibraryDocument(id, failure.message),
        catch: () =>
          new LibraryIngestFailure({ message: 'Library ingest failure could not be recorded' }),
      }),
    ),
  )
})
