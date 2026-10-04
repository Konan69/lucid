import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as Transferable from 'effect/unstable/workers/Transferable'

/**
 * The extraction vocabulary shared by the server and the extraction process: the typed failures and
 * the one RPC. This module is a leaf. It imports nothing from the library, so the process entry, the
 * process adapter and the parent orchestration can each import it without loading one another and
 * without an import cycle. `../extraction.ts` re-exports these names for the rest of the server.
 */

/** Only pdf.js's InvalidPDFException proves invalid content (unpdf 1.8.1 pdfjs.mjs, wrapReason). */
export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()(
  'PdfUnreadable',
  {},
  { title: 'Unreadable PDF' },
) {}

/** pdf.js PasswordException codes 1 and 2 require a password; provider details stay in the process. */
export class PdfLocked extends Schema.TaggedError<PdfLocked>()(
  'PdfLocked',
  {},
  { title: 'Locked PDF' },
) {}

/** An unpdf rejection outside the two known content names remains retryable, without raw details. */
export class ExtractionFaulted extends Schema.TaggedError<ExtractionFaulted>()(
  'ExtractionFaulted',
  {},
  { title: 'PDF extraction faulted' },
) {}

/**
 * The decision records which bounded resource ended extraction, independently of the induced exit.
 * `time` is decided by the deadline before the process is stopped. `heap` is decided only from a
 * Node diagnostic report that names the ended process and V8's heap-OOM handler; a signal alone
 * never earns it.
 */
export class ExtractionLimitExceeded extends Schema.TaggedError<ExtractionLimitExceeded>()(
  'ExtractionLimitExceeded',
  { limit: Schema.Literals(['time', 'heap']) },
  { title: 'PDF extraction limit exceeded' },
) {}

/** Refused or failed startup, unexpected process end, or broken transport; all remain retryable. */
export class ExtractionUnavailable extends Schema.TaggedError<ExtractionUnavailable>()(
  'ExtractionUnavailable',
  {},
  { title: 'PDF extraction unavailable' },
) {}

/**
 * Transferable.ts:160-175, 197-200 passes the `Uint8Array` through the RPC JSON codec unchanged, so
 * the raw bytes reach the transport. Over process IPC there is no transfer list
 * (NodeWorker.ts:44-46 drops it); the bytes are copied by Node's advanced serialization at `send`.
 */
export const ExtractionRpcs = RpcGroup.make(
  Rpc.make('ExtractPdf', {
    payload: { bytes: Transferable.Uint8Array },
    success: Schema.Array(Schema.String),
    error: Schema.Union([PdfUnreadable, PdfLocked, ExtractionFaulted]),
  }),
)
