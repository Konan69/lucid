import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type LibraryItemId } from '@vivid/contracts'
import { type extractPdf, type ExtractionLimitExceeded } from './extraction.ts'
import type { IndexedChunk } from './store.ts'
import {
  INGESTION_ATTEMPTS,
  IngestionOutcome,
  type OwedLibraryItem,
  type ingestionOperations,
} from './ingestion.ts'

const MAX_CHUNK_CHARACTERS = 1_400
const CHUNK_OVERLAP_CHARACTERS = 180
const PDF_FAILURE_MESSAGE = 'PDF text extraction failed'
export const MAX_LIBRARY_FILE_BYTES = 10 * 1024 * 1024
export const LIBRARY_FILE_TYPES = ['application/pdf', 'text/markdown', 'text/plain'] as const

/** Every bounded extraction failure has a product sentence; unavailable infrastructure still fails. */
const EXTRACTION_LIMIT_MESSAGES: Record<ExtractionLimitExceeded['limit'], string> = {
  time: 'This PDF took too long to read',
  heap: 'This PDF is too large to read',
}

/** The exact bytes identify a duplicate within a shelf, independent of its display name. */
export const digestBytes = (bytes: Uint8Array) =>
  NodeCrypto.createHash('sha256').update(bytes).digest('hex')

/**
 * Strip NUL before normalizing whitespace because PostgreSQL text cannot store it. Empty content
 * still follows the existing unreadable-item failure; previews and chunks share this boundary.
 */
const normalizeText = (text: string) =>
  text
    .replaceAll('\u0000', '')
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
    const chunk = normalized.slice(start, end).trim()
    if (chunk.length > 0) chunks.push({ page, text: chunk })
    if (end >= normalized.length) break
    start = Math.max(end - CHUNK_OVERLAP_CHARACTERS, start + 1)
  }
  return chunks
}

export class LibraryIngestFailure extends Schema.TaggedError<LibraryIngestFailure>()(
  'LibraryIngestFailure',
  { message: Schema.String },
  { title: 'Library ingest failure' },
) {}

/**
 * Text decodes locally; PDF work stays inside the injected real native extraction boundary.
 * Only known content/limit failures become product sentences; infrastructure and defects propagate.
 */
const extractPages = (extract: typeof extractPdf) =>
  Effect.fn('LibraryIngest.extractPages')(function* (document: OwedLibraryItem) {
    const pdf =
      document.mimeType === 'application/pdf' || document.name.toLocaleLowerCase().endsWith('.pdf')
    if (!pdf) {
      const decodedText = new TextDecoder('utf-8', { fatal: false }).decode(document.bytes)
      return [{ page: null, text: normalizeText(decodedText) }]
    }
    const pages = yield* extract(document.bytes).pipe(
      Effect.catchTag('PdfUnreadable', () =>
        Effect.fail(new LibraryIngestFailure({ message: PDF_FAILURE_MESSAGE })),
      ),
      Effect.catchTag('PdfLocked', () =>
        Effect.fail(new LibraryIngestFailure({ message: 'This PDF is locked with a password' })),
      ),
      Effect.catchTag('ExtractionLimitExceeded', (failure) =>
        Effect.fail(
          new LibraryIngestFailure({ message: EXTRACTION_LIMIT_MESSAGES[failure.limit] }),
        ),
      ),
    )
    return pages.map((text, index) => ({ page: index + 1, text: normalizeText(text) }))
  })

/**
 * Product outcomes include empty content. A parser fault on delivery eight settles the bounded failure;
 * earlier ExtractionFaulted deliveries remain owed (PQ rc.116:104-108, 1749-1755).
 * Infrastructure and defects propagate independently of this bounded parser policy.
 */
const read = (extract: typeof extractPdf) =>
  Effect.fn('LibraryIngest.read')(
    function* (document: OwedLibraryItem, attempt: number) {
      const pages = yield* extractPages(extract)(document).pipe(
        Effect.catchTag('ExtractionFaulted', (failure) =>
          Effect.fail(
            attempt >= INGESTION_ATTEMPTS
              ? new LibraryIngestFailure({ message: PDF_FAILURE_MESSAGE })
              : failure,
          ),
        ),
      )
      const extractedText = pages
        .map((page) => page.text)
        .filter((text) => text.length > 0)
        .join('\n\n')
      if (extractedText.length === 0)
        return yield* Effect.fail(
          new LibraryIngestFailure({ message: 'No readable text was found in this document' }),
        )
      const chunks = pages.flatMap((page) => chunkText(page.text, page.page))
      if (chunks.length === 0)
        return yield* Effect.fail(
          new LibraryIngestFailure({ message: 'No searchable text was found in this document' }),
        )
      return IngestionOutcome.cases.Indexed.make({ extractedText, chunks })
    },
    Effect.catchTag('LibraryIngestFailure', (failure) =>
      Effect.succeed(IngestionOutcome.cases.Failed.make({ message: failure.message })),
    ),
  )

/**
 * Attempt nine settles visible exhaustion before reading any file. The SDK public attempt number
 * is authoritative (rc.116 PersistedQueue.ts:104-108); row-qualified settlement repays redelivery
 * without rewriting a settled item. Content outcomes succeed; faults remain owed by the SDK.
 */
export const ingestOwed = (
  operations: ReturnType<typeof ingestionOperations>,
  extract: typeof extractPdf,
) =>
  Effect.fn('LibraryIngest.ingestOwed')(function* (itemId: LibraryItemId, attempt: number) {
    if (attempt > INGESTION_ATTEMPTS) {
      yield* operations.settle(
        itemId,
        IngestionOutcome.cases.Failed.make({
          message: 'Vivid could not read this file. Remove it and upload it again.',
        }),
      )
      return
    }
    const document = yield* operations.owed(itemId)
    if (Option.isNone(document)) return
    yield* operations.settle(itemId, yield* read(extract)(document.value, attempt))
  })
