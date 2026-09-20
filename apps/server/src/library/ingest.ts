import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { extractText } from 'unpdf'
import type { LibraryItemId } from '@vivid/contracts'
import { LibraryStore, type IndexedChunk, type StoredLibraryItem } from './store.ts'

const MAX_CHUNK_CHARACTERS = 1_400
const CHUNK_OVERLAP_CHARACTERS = 180
export const MAX_LIBRARY_FILE_BYTES = 10 * 1024 * 1024
export const LIBRARY_FILE_TYPES = ['application/pdf', 'text/markdown', 'text/plain'] as const

export const digestBytes = (bytes: Uint8Array) =>
  NodeCrypto.createHash('sha256').update(bytes).digest('hex')

const normalizeText = (text: string) =>
  text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

/** Splits extracted text into overlapping search chunks without breaking useful boundaries. */
const chunkText = (text: string, page: number | null): ReadonlyArray<IndexedChunk> => {
  const normalized = normalizeText(text)
  if (normalized.length === 0) return []
  const chunks: Array<IndexedChunk> = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + MAX_CHUNK_CHARACTERS, normalized.length)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end))
      if (boundary > start + MAX_CHUNK_CHARACTERS / 2) end = boundary
    }
    const text = normalized.slice(start, end).trim()
    if (text.length > 0) chunks.push({ page, text })
    if (end >= normalized.length) break
    start = Math.max(end - CHUNK_OVERLAP_CHARACTERS, start + 1)
  }
  return chunks
}

export class LibraryIngestFailure extends Schema.TaggedError<LibraryIngestFailure>()(
  'LibraryIngestFailure',
  { message: Schema.String },
) {}

/** `unpdf` is Promise-only; this is the single unsafe extraction edge. */
const extractPages = Effect.fn('LibraryIngest.extractPages')(function* (
  document: StoredLibraryItem,
) {
  const pdf =
    document.mimeType === 'application/pdf' || document.name.toLocaleLowerCase().endsWith('.pdf')
  if (!pdf) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(document.bytes)
    return [{ page: null, text: normalizeText(text) }]
  }
  const result = yield* Effect.tryPromise({
    try: () => extractText(document.bytes, { mergePages: false }),
    catch: () => new LibraryIngestFailure({ message: 'PDF text extraction failed' }),
  })
  const pages = Array.isArray(result.text) ? result.text : [result.text]
  return pages.map((text, index) => ({ page: index + 1, text: normalizeText(text) }))
})

/** Extracts and indexes one uploaded item, recording expected failures on its durable row. */
export const ingestLibraryItem = Effect.fn('LibraryIngest.ingestItem')(function* (
  id: LibraryItemId,
) {
  const library = yield* LibraryStore
  const document = yield* library.getStoredItem(id)
  if (document === undefined) {
    return yield* Effect.fail(new LibraryIngestFailure({ message: 'Library item not found' }))
  }
  const index = Effect.gen(function* () {
    const pages = yield* extractPages(document)
    const extractedText = pages
      .map((page) => page.text)
      .filter((text) => text.length > 0)
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
    yield* library.completeItem(id, extractedText, chunks)
  })
  return yield* index.pipe(Effect.catch((failure) => library.failItem(id, failure.message)))
})
