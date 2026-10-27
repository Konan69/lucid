import type { Context, JsonValue } from '@earendil-works/chord'
import { apply, type Op } from '@earendil-works/chord/delta'
import { StorageRequestError } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentContent,
  DocumentCreate,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  JsonObject,
  Page,
  ScanOrder,
  Seq,
  Storage,
  StorageWrite,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from '@earendil-works/pi-durable'
import * as NodeEvents from 'node:events'
import { Data, Option, Predicate, Result, Schema } from 'effect'
import type { Database, Executor, RecordKindName, SqlValue, Statement } from './database.ts'
import { safeNumber } from './database.ts'
import {
  AddressOccupied,
  CopyRejected,
  CopySourceChanged,
  CopySourceMismatch,
  CopySourceUnreadable,
  DeltaWithoutBase,
  DocumentContentRepeated,
  DocumentExists,
  DocumentRetired,
  DocumentRetiredTwice,
  DocumentUnknown,
  IdKindsDiffer,
  IdRepeated,
  IdsExhausted,
  IdTaken,
  RevisionsCorrupt,
  StorageInvalid,
  StoreClosed,
  StoreMissing,
  VersionWithoutBase,
} from './errors.ts'
import {
  ConversationEnvelope,
  DocumentEnvelope,
  EntryEnvelope,
  StoredEntry,
  SubmissionEnvelope,
  TaskEnvelope,
} from './records.ts'
import { scanSql, scanStart } from './scan.ts'
import { Statements } from './statements.ts'

/** Pi Storage remains a Promise protocol. Decode with Result at its driver ingress, converting
 * only malformed persisted data to a contextual tagged rejection. No throwing Schema decoder
 * or raw invalid row escapes; valid Pi extension fields stay intact. */
function decodeStored<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  recordKind: RecordKindName,
) {
  const decode = Schema.decodeUnknownResult(schema)
  return (value: Parameters<typeof decode>[0], recordId: Option.Option<string>): S['Type'] =>
    Result.getOrThrowWith(decode(value), () =>
      Option.match(recordId, {
        onNone: () => new StorageInvalid({ recordKind }),
        onSome: (id) => new StorageInvalid({ recordKind, recordId: id }),
      }),
    )
}

/** Ownership columns survive corrupt JSON and supply safe row diagnostics. Pi still owns
 * extension payloads; the row decoder checks its envelope without stripping those fields. */
function scopedResult<
  T extends { readonly id: Id<string>; readonly conversationId: ConversationId },
>(
  row: ScopedJsonRow,
  input: {
    decode: (value: string) => Result.Result<T, Schema.SchemaError>
    recordKind: 'task' | 'submission'
    status: (value: T) => string
  },
) {
  const conversationId = decodeConversationId(safeNumber(row.conversation_id), Option.some(row.id))
  const id = entryId(safeNumber(row.id), Option.some(row.id))
  const invalid = () =>
    new StorageInvalid({ recordKind: input.recordKind, recordId: row.id, conversationId })
  const value = Result.flatMap(Result.mapError(input.decode(row.record), invalid), (record) =>
    record.id === id &&
    record.conversationId === conversationId &&
    input.status(record) === row.status
      ? Result.succeed(record)
      : Result.fail(invalid()),
  )
  return { id, conversationId, value }
}

/** Pi src/ids.ts:idFromNumber, numeric brands at the trusted allocation/driver boundary.
 * Repository rules require a schema rather than a runtime typeof check or generic cast. */
const NumericId = Schema.Int
const isNumericId = Schema.is(NumericId)
const entryId = decodeStored(
  Schema.declare<EntryId>((value): value is EntryId => isNumericId(value)),
  'entry',
)
const decodeConversationId = decodeStored(
  Schema.declare<ConversationId>((value): value is ConversationId => isNumericId(value)),
  'conversation',
)
const documentId = decodeStored(
  Schema.declare<DocumentId>((value): value is DocumentId => isNumericId(value)),
  'document',
)
const seqFromNumber = decodeStored(
  Schema.declare<Seq>((value): value is Seq => isNumericId(value)),
  'metadata',
)

/** The larger of two ids; bigint keeps the exhausted-space sentinel exact. */
function maxId(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}

/** Pi SqliteStorage closeDatabase/admitRead, drain admitted reads
 * before closing. Node event settlement replaces the raw Promise constructor to
 * comply with repository lint; the signal is only released when close is pending. */
function drainSignal() {
  const events = new NodeEvents.EventEmitter()
  return {
    promise: NodeEvents.EventEmitter.once(events, 'drained').then(() => {}),
    resolve: () => {
      events.emit('drained')
    },
  }
}

/** Exhaustive Pi variants: a new SDK case must fail typecheck instead of silently falling through. */
function exhaustive(value: never): never {
  throw new TypeError(`Unexpected Pi variant: ${String(value)}`)
}

/** Pi SqliteStorage row/action types; BIGINT driver fields become
 * strings until their checked numeric conversion at the Storage boundary. */
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>
type TableName = Exclude<RecordKindName, 'metadata'>
type JsonRow = { readonly id: string; readonly record: string }
type ScopedJsonRow = JsonRow & {
  readonly id: string
  readonly conversation_id: string
  readonly status: string
}
type EntryJsonRow = JsonRow & { readonly commit_seq: string }
type DocumentReadRow = {
  readonly record: string
  readonly base: string | null
  readonly tail: string
}
const RevisionWire = Schema.Struct({
  seq: Schema.String,
  kind: Schema.Literals(['base', 'delta']),
  version: Schema.String,
  content: Schema.String,
})
const decodeRevision = decodeStored(Schema.fromJsonString(RevisionWire), 'document')
const decodeRevisions = decodeStored(Schema.fromJsonString(Schema.Array(RevisionWire)), 'document')
type IdRow = { readonly id: string }
const decodeMetadataRow = decodeStored(Schema.Struct({ next_seq: Schema.String }), 'metadata')
const decodeRecordIdRow = decodeStored(
  Schema.Struct({
    record_type: Schema.Literals(['conversation', 'entry', 'task', 'submission', 'document']),
  }),
  'metadata',
)

/** Pi checkGlobalIds visits all created record identities in write order. */
function globalClaims(writes: readonly StorageWrite[]) {
  const claims: { readonly id: Id<string>; readonly table: TableName }[] = []
  for (const write of writes) {
    if (write.type === 'document.change' || write.type === 'document.retire') continue
    const document = write.type === 'document.create' || write.type === 'document.copy'
    claims.push({
      id: document ? write.record.id : write.value.id,
      table: document ? 'document' : write.type,
    })
  }
  return claims
}
type CopySource = Extract<StorageWrite, { readonly type: 'document.copy' }>['source']
type BaseContent = Extract<DocumentContent, { readonly kind: 'base' }>

/**
 * What one batch does to one document, after its commands are grouped (Pi
 * `SqliteStorage.prepareDocumentActions`): a new incarnation made from a base or copied from
 * another, a content change of an existing one, or only its retirement. Each but `Retire` can
 * also retire the document in the same batch. The legal combinations are these variants; the
 * reference kept them as optional fields checked imperatively.
 */
type DocumentAction = Data.TaggedEnum<{
  Create: {
    readonly record: DocumentCreate
    readonly content: BaseContent
    readonly retire: boolean
  }
  Copy: { readonly record: DocumentCreate; readonly source: CopySource; readonly retire: boolean }
  Change: { readonly content: DocumentContent; readonly retire: boolean }
  Retire: {}
}>
const DocumentAction = Data.taggedEnum<DocumentAction>()

/** Whether the action ends the incarnation in this batch. */
const retires = (action: DocumentAction): boolean =>
  DocumentAction.$match(action, {
    Create: (create) => create.retire,
    Copy: (copy) => copy.retire,
    Change: (change) => change.retire,
    Retire: () => true,
  })
type ScopeColumns = {
  readonly scopeKind: DocumentRecord['scope']['kind']
  readonly ownerId: number
}

/** Pi SqliteStorage parseJson. Storage trusts its owning Session's
 * record shapes (src/types.ts:Storage); these are reads of that typed writer's JSON,
 * not incoming provider/network payloads. The named JSON codec checks syntax and
 * JSON envelopes without stripping extension fields; Pi still owns payload schemas and transitions.
 * SAFETY: Pi's Storage contract supplies each table's record type; serialization is
 * unchanged JSON text. Only the corresponding reader is used for each table.
 */
const decodeJson = decodeStored(
  Schema.fromJsonString(Schema.declare<typeof DocumentEnvelope.Type>(Schema.is(DocumentEnvelope))),
  'document',
)
/** Native ConversationRecord has an immutable identity plus optional fork/creator edges.
 * JSON syntax alone cannot establish those relations; a malformed conversation is a typed
 * persisted-row failure before Harness tries to navigate it. Extension fields remain intact. */
const isConversationEnvelope = Schema.is(ConversationEnvelope)
const decodeConversation = decodeStored(
  Schema.fromJsonString(
    Schema.declare<ConversationRecord>((value): value is ConversationRecord =>
      isConversationEnvelope(value),
    ),
  ),
  'conversation',
)
/** Pi Storage's extracted ids, versions and Chord offsets are finite domain
 * numbers. JSON cannot persist NaN or infinities as numbers; payload JSON remains
 * the reference's text, while these envelopes reject impossible numeric rows. */
const HeadEnvelope = Schema.Struct({ ...EntryEnvelope.fields, head: Schema.Finite })
/** Pi types.ts TaskOutcome and TaskState are closed external states. The SDK writer omits
 * undefined void inputs/results (transaction.ts TABLE_JSON_COPY_OPTIONS), so only those fields
 * permit absence. Scheduler-required checkpoints, dependency arrays, policies and errors do not.
 * The native status unions own coverage; a pinned SDK adding a case fails these declarations. */
const decodeEntry = decodeStored(Schema.fromJsonString(StoredEntry), 'entry')
const decodeHead = decodeStored(
  Schema.fromJsonString(Schema.declare<typeof HeadEnvelope.Type>(Schema.is(HeadEnvelope))),
  'entry',
)
const isTaskEnvelope = Schema.is(TaskEnvelope)
const isSubmissionEnvelope = Schema.is(SubmissionEnvelope)
const TaskJson = Schema.fromJsonString(
  Schema.declare<StoredTask>((value): value is StoredTask => isTaskEnvelope(value)),
)
const taskResult = Schema.decodeUnknownResult(TaskJson)
const submissionResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.declare<SubmissionRecord>((value): value is SubmissionRecord =>
      isSubmissionEnvelope(value),
    ),
  ),
)
const decodeSubmission = decodeStored(
  Schema.fromJsonString(
    Schema.declare<SubmissionRecord>((value): value is SubmissionRecord =>
      isSubmissionEnvelope(value),
    ),
  ),
  'submission',
)
const Segment = Schema.Union([Schema.String, Schema.Finite])
const Path = Schema.Array(Segment)
const NonEmptyPath = Schema.NonEmptyArray(Segment)
const Operations = Schema.Array(
  Schema.Union([
    Schema.Tuple([Schema.Literal('r'), Schema.MutableJson]),
    Schema.Tuple([Schema.Literal('s'), NonEmptyPath, Schema.MutableJson]),
    Schema.Tuple([Schema.Literal('d'), NonEmptyPath]),
    Schema.Tuple([Schema.Literal('a'), NonEmptyPath, Schema.String]),
    Schema.Tuple([Schema.Literal('t'), NonEmptyPath, Schema.Finite]),
    Schema.Tuple([
      Schema.Literal('p'),
      Path,
      Schema.Finite,
      Schema.Finite,
      Schema.mutable(Schema.Array(Schema.MutableJson)),
    ]),
    Schema.Tuple([Schema.Literal('m'), Path, Schema.mutable(Schema.Array(Schema.Finite))]),
  ]),
)
/** Pi parseJson<ConversationRecord>: decode the immutable owning Session record. */
const parseConversation = (value: string, recordId: string) => {
  // SAFETY: conversations.record round-trips the owning Session's ConversationRecord.
  return decodeConversation(value, Option.some(recordId))
}
/** Pi parseJson<EntryRecord>: preserve its application and model payloads unchanged. */
const parseEntry = (value: string, recordId: string) => {
  // SAFETY: entries.record round-trips the owning Session's EntryRecord, including extensions.
  return decodeEntry(value, Option.some(recordId))
}
/** Pi readLatestHeadMarker: its SQL predicate establishes the required head field. */
const parseHead = (value: string, recordId: string) => {
  // SAFETY: SQL selects only entries where the extracted head column is non-null.
  return decodeHead(value, Option.some(recordId)) as EntryRecord & { readonly head: EntryId }
}
/** Pi parseJson<SubmissionRecord>: preserve the receipt state and deduplication payload. */
const parseSubmission = (value: string, recordId: string) => {
  // SAFETY: submissions.record round-trips the owning Session's SubmissionRecord.
  return decodeSubmission(value, Option.some(recordId))
}
/** Pi parseJson<DocumentRecord>: preserve the incarnation lifetime stamped by storage. */
const parseDocument = (value: string, recordId: string) => {
  // SAFETY: documents.record is stamped by this storage from Session-owned DocumentCreate.
  return decodeJson(value, Option.some(recordId)) as DocumentRecord
}
/** Pi parseJson<JsonObject>: base content is a JSON object; preserve mutable Chord arrays. */
const parseObject = decodeStored(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
  'document',
)
const parseOperations = decodeStored(Schema.fromJsonString(Operations), 'document')

/** Pi encodeJson: serialize trusted typed records without key sorting or numeric rewriting.
 * JSON.stringify preserves Pi's omission of undefined optional keys. */
const encodeJson = (
  value:
    | ConversationRecord
    | EntryRecord
    | StoredTask
    | SubmissionRecord
    | DocumentRecord
    | JsonObject
    | readonly Op[],
): string => JSON.stringify(value)
/** Pi SqliteStorage encodeIndexedString, retained unchanged.
 * PostgreSQL TEXT rejects NUL and encodes Unicode scalars; JSON string text keeps
 * indexed identities lossless, including NUL and lone UTF-16 surrogates. */
const encodeIndexedString = (value: string): string => JSON.stringify(value)

/** Pi SqliteStorage (cursorId). Document scans
 * keep the ascending numeric bound; order-aware table scans use scan.ts. */
const cursorId = (cursor: Parameters<Storage['scanTasks']>[2]) => {
  const after = cursor === undefined ? undefined : cursor.after
  if (cursor === undefined) return undefined
  if (!isNumericId(after)) throw new StorageRequestError('Invalid storage cursor')
  return after
}

/** Pi SqliteStorage (page). The extra row determines
 * continuation; the last returned id and scan direction form its opaque cursor. */
const page = <T extends { readonly id: Id<string> }>(
  values: readonly T[],
  limit: number,
  order: ScanOrder = 'ascending',
): Page<T, Cursor> => {
  const items = values.slice(0, limit)
  if (values.length <= limit) return { items }
  return { items, next: { after: Option.getOrThrow(Option.fromNullishOr(items.at(-1))).id, order } }
}

/** Pi SqliteStorage scopeColumns. Session ownership uses reserved zero; other scopes use their actual owner id. */
const scopeColumns = (scope: DocumentRecord['scope']): ScopeColumns => {
  switch (scope.kind) {
    case 'session':
      return { scopeKind: 'session', ownerId: 0 }
    case 'conversation':
      return { scopeKind: 'conversation', ownerId: scope.conversationId }
    case 'task':
      return { scopeKind: 'task', ownerId: scope.taskId }
    default:
      return exhaustive(scope)
  }
}

/** Pi SqliteStorage addressParts. Family presence distinguishes a singleton from the empty-string key; this is not a fallback identity. */
const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
  const scope = scopeColumns(address.scope)
  return {
    kind: encodeIndexedString(address.kind),
    ...scope,
    family: address.key === undefined ? 0 : 1,
    keyValue: encodeIndexedString(address.key === undefined ? '' : address.key),
  }
}

/** Pi SqliteStorage addressKey. One exact address key combines scope, kind and family identity during batch validation. */
const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
  const parts = addressParts(address)
  return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue])
}

/** Pi SqliteStorage isAliveAt. Creation is inclusive and retirement exclusive; current reads see only live incarnations. */
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === 'current') return record.retiredAt === undefined
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt)
}

/** Pi SqliteStorage isCurrentOnly. Only rewindable conversation documents retain historical bases and deltas. */
const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== 'conversation' || record.history === 'latest'

/** Pi SqliteStorage writeId. Changes and retirement do not allocate ids; creation and table replacement writes may advance the watermark. */
const writeId = (write: StorageWrite) => {
  switch (write.type) {
    case 'conversation':
    case 'entry':
    case 'task':
    case 'submission':
      return write.value.id
    case 'document.create':
    case 'document.copy':
      return write.record.id
    case 'document.change':
    case 'document.retire':
      return undefined
    default:
      return exhaustive(write)
  }
}

/**
 * Pi `SqliteStorage.candidateNextId`: one past the highest id the batch creates, which the
 * commit raises the store's watermark to. Zero when the batch creates nothing.
 */
function candidateNextId(writes: readonly StorageWrite[]): bigint {
  let nextId = 0n
  for (const write of writes) {
    const id = writeId(write)
    if (id !== undefined) nextId = maxId(nextId, BigInt(id) + 1n)
  }
  return nextId
}

/** Pi SqliteStorage.applyDocumentActions content egress, split only for complexity.
 * Base JSON and Chord tuples retain their exact serialization, not JSONB. */
function contentJson(content: DocumentContent): string {
  return content.kind === 'base' ? encodeJson(content.value) : encodeJson(content.ops)
}

/** Pi SqliteStorage.checkGlobalIds comparison branch; immutable types cannot be
 * reused, while task/submission writes may replace only their own record type. */
function checkOwnership(
  id: Id<string>,
  table: TableName,
  existing: Option.Option<TableName>,
  earlier: Option.Option<TableName>,
) {
  const immutable = table === 'conversation' || table === 'entry' || table === 'document'
  if (Option.isSome(existing) && (immutable || existing.value !== table))
    throw new IdTaken({ id, owner: existing.value })
  if (Option.isNone(earlier)) return
  if (immutable) throw new IdRepeated({ id })
  if (earlier.value !== table) throw new IdKindsDiffer({ id })
}

type DocumentWrite = Extract<
  StorageWrite,
  { readonly type: 'document.create' | 'document.copy' | 'document.change' | 'document.retire' }
>
/** Pi prepareDocumentActions identity selection; create/copy use the new record,
 * change/retire use the existing incarnation. Kept separate for complexity lint. */
function documentWriteId(write: DocumentWrite): DocumentId {
  switch (write.type) {
    case 'document.create':
    case 'document.copy':
      return write.record.id
    case 'document.change':
    case 'document.retire':
      return write.id
    default:
      return exhaustive(write)
  }
}
/**
 * Pi SqliteStorage.prepareDocumentActions: add one command to what the batch already does to the
 * document. A content command (create, copy, change) joins nothing or a lone retirement; a
 * retirement joins anything not already retiring. The reference's conflicts and their order.
 */
function withCommand(
  id: DocumentId,
  action: Option.Option<DocumentAction>,
  write: DocumentWrite,
): DocumentAction {
  switch (write.type) {
    case 'document.create':
      return DocumentAction.Create({
        record: write.record,
        content: write.content,
        retire: retiredBefore(id, action),
      })
    case 'document.copy':
      return DocumentAction.Copy({
        record: write.record,
        source: write.source,
        retire: retiredBefore(id, action),
      })
    case 'document.change':
      return DocumentAction.Change({ content: write.content, retire: retiredBefore(id, action) })
    case 'document.retire':
      return Option.match(action, {
        onNone: () => DocumentAction.Retire(),
        onSome: (earlier) => retired(id, earlier),
      })
    default:
      return exhaustive(write)
  }
}

/** A content command may join only nothing or a lone retirement; says whether it retires. */
function retiredBefore(id: DocumentId, action: Option.Option<DocumentAction>): boolean {
  if (Option.isNone(action)) return false
  if (Predicate.isTagged(action.value, 'Retire')) return true
  throw new DocumentContentRepeated({ documentId: id })
}

/** The same action, now also retiring the document; a second retirement is refused. */
function retired(id: DocumentId, action: DocumentAction): DocumentAction {
  if (retires(action)) throw new DocumentRetiredTwice({ documentId: id })
  return DocumentAction.$match(action, {
    Create: (earlier) => DocumentAction.Create({ ...earlier, retire: true }),
    Copy: (earlier) => DocumentAction.Copy({ ...earlier, retire: true }),
    Change: (earlier) => DocumentAction.Change({ ...earlier, retire: true }),
    Retire: () => DocumentAction.Retire(),
  })
}

/** The incarnation an action makes, when it makes one. */
const created = (action: DocumentAction): Option.Option<DocumentCreate> =>
  Predicate.isTagged(action, 'Create') || Predicate.isTagged(action, 'Copy')
    ? Option.some(action.record)
    : Option.none()

/** Pi checkDocumentActions existence/retirement branch: the record the action applies to. */
function checkDocumentRecord(
  id: DocumentId,
  action: DocumentAction,
  existing: Option.Option<DocumentRecord>,
): DocumentRecord | DocumentCreate {
  const making = created(action)
  if (Option.isNone(making)) {
    if (Option.isNone(existing)) throw new DocumentUnknown({ documentId: id })
    if (existing.value.retiredAt !== undefined) throw new DocumentRetired({ documentId: id })
    return existing.value
  }
  if (Option.isSome(existing)) throw new DocumentExists({ documentId: id })
  return making.value
}

/**
 * The opaque identity of one store (`runtime.stores.id`), made once when its Person is first
 * seen (`stores.ts`). A UUID, never a Person's id, so a store can move or change owner without
 * its rows being rewritten.
 */
export const StoreId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('StoreId'))
export type StoreId = typeof StoreId.Type

/**
 * How many ids one reservation takes. Each reservation is one fenced transaction; a block of 64
 * covers a reply's entries, tasks and documents several times over.
 */
const RESERVATION = 64

/** The block a reservation took: ids from `start` up to, not including, `until`. */
const decodeReservation = decodeStored(
  Schema.Struct({ start: Schema.String, until: Schema.String }),
  'metadata',
)

/**
 * One Person's Pi Durable store, as rows of the shared tables that carry its `store_id`. A port of
 * Pi's reference storage (`SqliteStorage`, `src/storage/` of `@earendil-works/pi-durable`) by way of the earlier PostgreSQL port
 * (`PostgresStorage` on the `ai-sdk-durable` branch, which passed Pi's conformance suite with one
 * schema and one leased connection per store). What changed and why:
 *
 * - Every key, lookup, index, conflict target, UPDATE and DELETE names the store, so stores share
 *   tables without meeting. Pi's ids stay local numbers: the store id is their namespace.
 * - The allocator is this store's own `runtime.metadata` row. Ids are reserved in blocks by a
 *   fenced transaction before any is handed out, so an id is above every id minted or stored
 *   before, also across a reopen (Pi `src/types.ts`, `Storage.mintId`). The reference persisted
 *   only the watermark of committed ids and could hand an unused id out twice.
 * - The database is shared (`driver.ts`): no connection is held by a store, and every write is
 *   fenced by the runtime's owner generation instead of a per-store lock.
 * - Closing waits for the work it admitted and releases nothing else: the pool belongs to the
 *   process.
 */
export class PostgresStore implements Storage {
  readonly storeId: StoreId
  private readonly db: Database
  /** The next id to hand out and the end of the block reserved for it. */
  private nextId = 0n
  private reservedUntil = 0n
  private reserving = Option.none<Promise<void>>()
  private closed = false
  private closing = Option.none<Promise<void>>()
  private admitted = 0
  private readonly drained = drainSignal()
  /** The committed conversation records this store has read, as stored (`readConversation`). */
  private readonly conversations = new Map<ConversationId, JsonRow>()

  private constructor(db: Database, storeId: StoreId) {
    this.db = db
    this.storeId = storeId
  }

  /**
   * Open one store. Its metadata row is made with the store (`stores.ts`); a store without one
   * was never created, which is refused rather than started from nothing.
   */
  static open(db: Database, storeId: StoreId): Promise<PostgresStore> {
    return db
      .get<IdRow>('SELECT store_id::text AS id FROM runtime.metadata WHERE store_id = ?', storeId)
      .then((row) => {
        if (Option.isNone(row)) throw new StoreMissing({ storeId })
        return new PostgresStore(db, storeId)
      })
  }

  /**
   * Pi `SqliteStorage.commit`: the sequence is allocated inside the transaction. BEGIN, the
   * fence, the metadata read and the id-ownership reads go in one round trip; the final writes
   * and COMMIT in another. Document checks and writes that need what an earlier statement left
   * keep their own position in between, as in the reference.
   */
  commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    return this.admit(() => this.write(writes))
  }

  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.commit.
  private async write(writes: readonly StorageWrite[]) {
    const documentActions = this.prepareDocumentActions(writes)
    const candidate = candidateNextId(writes)
    const claims = globalClaims(writes)
    const reads: Statement[] = [
      {
        recordKind: 'metadata',
        sql: 'SELECT next_seq FROM runtime.metadata WHERE store_id = ?',
        params: [this.storeId],
      },
      ...claims.map((claim) => ({
        recordKind: claim.table,
        sql: 'SELECT record_type FROM runtime.record_ids WHERE store_id = ? AND id = ?',
        params: [this.storeId, claim.id],
      })),
    ]
    const seq = await this.db.write(
      reads,
      // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.commit's transaction callback.
      async (transaction, rows) => {
        const metadataRows = Option.getOrThrow(Option.fromNullishOr(rows[0]))
        const metadataRow = Option.fromNullishOr(metadataRows[0])
        if (Option.isNone(metadataRow)) throw new StoreMissing({ storeId: this.storeId })
        const metadata = decodeMetadataRow(metadataRow.value, Option.some(this.storeId))
        const committedSeq = seqFromNumber(safeNumber(metadata.next_seq), Option.some(this.storeId))
        this.checkGlobalIds(claims, rows.slice(1))
        await this.checkDocumentActions(transaction, documentActions)
        const statements = new Statements()
        for (const write of writes) this.applyTableWrite(statements, write, committedSeq)
        if (documentActions.size > 0) {
          if (statements.values.length > 0) await transaction.runBatch(statements.values)
          statements.values.length = 0
          await this.applyDocumentActions(transaction, documentActions, committedSeq)
        }
        // An id written that this store never minted (Pi's reserved root, a test's own) still
        // raises the watermark, so no later reservation can hand it out.
        statements.run(
          'metadata',
          'UPDATE runtime.metadata SET next_id = GREATEST(next_id, ?), next_seq = ? WHERE store_id = ?',
          String(candidate),
          BigInt(committedSeq) + 1n,
          this.storeId,
        )
        return { value: committedSeq, statements: statements.values }
      },
    )
    this.nextId = maxId(this.nextId, candidate)
    return seq
  }

  /**
   * Pi `SqliteStorage.mintId`, from a reserved block. Ids within a block are handed out without
   * a database trip; the next block is reserved once this one is spent, and one reservation
   * serves every caller waiting for it.
   */
  mintId<I extends Id<string>>(): Promise<I> {
    return this.admit(() => this.mint<I>())
  }

  private mint<I extends Id<string>>(): Promise<I> {
    if (this.nextId >= this.reservedUntil) return this.reserve().then(() => this.mint<I>())
    if (this.nextId > BigInt(Number.MAX_SAFE_INTEGER))
      return Promise.reject(new IdsExhausted({ storeId: this.storeId }))
    // SAFETY: a safe integer from this store's own namespace; Pi's id brands are erased numbers.
    return Promise.resolve(Number(this.nextId++) as I)
  }

  /** Take the next block: one fenced UPDATE that moves this store's watermark past it. */
  private reserve(): Promise<void> {
    if (Option.isSome(this.reserving)) return this.reserving.value
    const reservation = this.db
      .write([], (transaction) =>
        transaction
          .get<object>(
            'UPDATE runtime.metadata SET next_id = next_id + ? WHERE store_id = ? RETURNING (next_id - ?)::text AS start, next_id::text AS until',
            RESERVATION,
            this.storeId,
            RESERVATION,
          )
          .then((row) => {
            if (Option.isNone(row)) throw new StoreMissing({ storeId: this.storeId })
            return {
              value: decodeReservation(row.value, Option.some(this.storeId)),
              statements: [],
            }
          }),
      )
      .then((block) => {
        this.nextId = maxId(this.nextId, BigInt(block.start))
        this.reservedUntil = BigInt(block.until)
      })
      .finally(() => {
        this.reserving = Option.none()
      })
    this.reserving = Option.some(reservation)
    return reservation
  }

  /** Pi SqliteStorage.conversation.
   * Return a detached exact record without following ancestry. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.conversation.
  async conversation(id: ConversationId, _context: Context) {
    this.assertOpen()
    return this.readConversation(id)
  }

  /** Pi SqliteStorage.scanConversations.
   * Honor query/cursor order and fetch limit plus one for continuation. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.scanConversations.
  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const start = scanStart(query.order, cursor, 'ascending')
    const scan = scanSql(start)
    const clauses = ['store_id = ?', scan.clause]
    const params: SqlValue[] = [this.storeId, scan.param]
    if (query.ownerConversationId !== undefined) {
      clauses.push('owner_conversation_id = ?')
      params.push(query.ownerConversationId)
    }
    if (query.ownerTaskId !== undefined) {
      clauses.push('owner_task_id = ?')
      params.push(query.ownerTaskId)
    }
    params.push(limit + 1)
    const rows = await this.db.all<JsonRow>(
      `SELECT id, record FROM runtime.conversations WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseConversation(row.record, row.id)),
      limit,
      start.order,
    )
  }

  entry(id: EntryId, context: Context): ReturnType<Storage['entry']>
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage['entry']>
  /** Pi SqliteStorage.entry.
   * Keep both global lookup and ancestry-filtered overloads behind read admission. */
  entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ) {
    return this.admit(() => this.readEntry(idOrConversationId, idOrContext, context))
  }

  /** Pi SqliteStorage.findLatestHeadMarker.
   * Read admission keeps ancestry traversal alive while close waits for its later SQL. */
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: Parameters<Storage['findLatestHeadMarker']>[1],
    _context: Context,
  ) {
    return this.admit(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId))
  }

  /** Pi SqliteStorage.scanEntries.
   * Both orders retain inclusive ancestry cutoffs. */
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.admit(() => this.readEntries(query, limit, cursor))
  }

  /** Pi SqliteStorage.readEntry.
   * An ancestry lookup hides entries beyond the parent fork cutoff and returns the stored commit sequence. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntry.
  private async readEntry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ) {
    if (!isNumericId(idOrConversationId) || (context !== undefined && !isNumericId(idOrContext)))
      throw new StorageRequestError('Storage.entry() requires an entry ID')
    const id =
      context === undefined
        ? entryId(idOrConversationId, Option.none())
        : isNumericId(idOrContext)
          ? entryId(idOrContext, Option.none())
          : undefined
    if (id === undefined) throw new TypeError('Storage.entry() requires an entry ID')
    if (context !== undefined)
      return this.readScopedEntry(decodeConversationId(idOrConversationId, Option.none()), id)
    const row = Option.getOrUndefined(
      await this.db.get<EntryJsonRow>(
        'SELECT id, record, commit_seq FROM runtime.entries WHERE store_id = ? AND id = ?',
        this.storeId,
        id,
      ),
    )
    if (row === undefined) return undefined
    const entry = parseEntry(row.record, row.id)
    return { entry, commitSeq: seqFromNumber(safeNumber(row.commit_seq), Option.some(row.id)) }
  }

  /** Pi SqliteStorage.readEntry scoped overload.
   * Walk immutable conversation ancestry in JavaScript exactly as the reference
   * does. PostgreSQL json extraction de-escapes the entire record, rejecting JSON
   * extensions containing escaped NUL or lone UTF16 surrogates. Reading only TEXT
   * preserves those values; this costs one indexed read per ancestor instead of
   * the previous recursive SQL query. No explicit transaction is needed because
   * ancestry and entries are immutable (Pi src/types.ts:Storage). */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntry ancestry branch.
  private async readScopedEntry(conversationId: ConversationId, id: EntryId) {
    let conversation = await this.readConversation(conversationId)
    if (conversation === undefined)
      throw new StorageRequestError(`Unknown conversation: ${conversationId}`)
    const row = Option.getOrUndefined(
      await this.db.get<EntryJsonRow>(
        'SELECT id, record, commit_seq FROM runtime.entries WHERE store_id = ? AND id = ?',
        this.storeId,
        id,
      ),
    )
    if (row === undefined) return undefined
    const entry = parseEntry(row.record, row.id)
    let upperEntryId = Number.POSITIVE_INFINITY
    while (conversation.id !== entry.conversationId) {
      if (conversation.parent === undefined) return undefined
      upperEntryId = Math.min(upperEntryId, conversation.parent.at)
      // Session guarantees existing, acyclic parents. Option replaces Pi's
      // non-null assertion without rewriting or interpreting the stored JSON.
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
    if (entry.id > upperEntryId) return undefined
    return { entry, commitSeq: seqFromNumber(safeNumber(row.commit_seq), Option.some(row.id)) }
  }

  /** Pi SqliteStorage.readLatestHeadMarker.
   * Find the newest visible marker before descending into parent ancestry. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readLatestHeadMarker.
  private async readLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: Parameters<Storage['findLatestHeadMarker']>[1],
  ) {
    let conversation = await this.readConversation(conversationId)
    if (conversation === undefined)
      throw new StorageRequestError(`Unknown conversation: ${conversationId}`)
    let upper: ReturnType<typeof cursorId> = atOrBeforeEntryId
    while (true) {
      const row =
        upper === undefined
          ? Option.getOrUndefined(
              await this.db.get<JsonRow>(
                'SELECT id, record FROM runtime.entries WHERE store_id = ? AND conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1',
                this.storeId,
                conversation.id,
              ),
            )
          : Option.getOrUndefined(
              await this.db.get<JsonRow>(
                'SELECT id, record FROM runtime.entries WHERE store_id = ? AND conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1',
                this.storeId,
                conversation.id,
                upper,
              ),
            )
      if (row !== undefined) return parseHead(row.record, row.id)
      if (conversation.parent === undefined) return undefined
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
  }

  /** Pi SqliteStorage.readEntries.
   * Resolve query/cursor direction before choosing the ancestry scan. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntries.
  private async readEntries(
    query: EntryQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
  ) {
    const { order, after } = scanStart(query.order, cursor, 'descending')
    return order === 'ascending'
      ? this.readEntriesAscending(query, limit, after)
      : this.readEntriesDescending(query, limit, after)
  }

  /** Pi SqliteStorage. Query descendant segments
   * first; each parent is capped at the fork so excluded entries never reappear. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntries descending branch.
  private async readEntriesDescending(
    query: EntryQuery,
    limit: number,
    after: Option.Option<number>,
  ) {
    let conversation = await this.readConversation(query.conversationId)
    if (conversation === undefined)
      throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`)
    let upper: ReturnType<typeof cursorId> = query.maxEntryId
    if (Option.isSome(after))
      upper = Math.min(upper === undefined ? Number.MAX_SAFE_INTEGER : upper, after.value - 1)
    const values: EntryRecord[] = []
    while (true) {
      const clauses = ['store_id = ?', 'conversation_id = ?']
      const params: SqlValue[] = [this.storeId, conversation.id]
      if (query.minEntryId !== undefined) {
        clauses.push('id >= ?')
        params.push(query.minEntryId)
      }
      if (upper !== undefined) {
        clauses.push('id <= ?')
        params.push(upper)
      }
      params.push(limit + 1 - values.length)
      const rows = await this.db.all<JsonRow>(
        `SELECT id, record FROM runtime.entries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        ...params,
      )
      values.push(...rows.map((row) => parseEntry(row.record, row.id)))
      if (values.length > limit || conversation.parent === undefined) break
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
      if (query.minEntryId !== undefined && upper < query.minEntryId) break
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
    return page(values, limit, 'descending')
  }

  /** Pi SqliteStorage. Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntriesAscending.
  private async readEntriesAscending(
    query: EntryQuery,
    limit: number,
    after: Option.Option<number>,
  ): Promise<Page<EntryRecord, Cursor>> {
    const segments = await this.readEntrySegments(query)
    let lower: Option.Option<number> = Option.fromNullishOr(query.minEntryId)
    if (Option.isSome(after))
      lower = Option.some(
        Math.max(
          Option.getOrElse(lower, () => after.value + 1),
          after.value + 1,
        ),
      )
    const values: EntryRecord[] = []
    // Oldest first: the walk found the segments newest first.
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = Option.getOrThrow(Option.fromNullishOr(segments[index]))
      const clauses = ['store_id = ?', 'conversation_id = ?']
      const params: SqlValue[] = [this.storeId, segment.conversationId]
      if (Option.isSome(lower)) {
        clauses.push('id >= ?')
        params.push(lower.value)
      }
      if (Option.isSome(segment.upper)) {
        clauses.push('id <= ?')
        params.push(segment.upper.value)
      }
      params.push(limit + 1 - values.length)
      const rows = await this.db.all<JsonRow>(
        `SELECT id, record FROM runtime.entries WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`,
        ...params,
      )
      values.push(...rows.map((row) => parseEntry(row.record, row.id)))
      if (values.length > limit) break
    }
    return page(values, limit, 'ascending')
  }

  /** Pi SqliteStorage. Discover the fork chain
   * before an ascending scan so roots precede descendants, each with its exact
   * inclusive bound. Keep bounds as Options outside the SDK's query contract. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readEntriesAscending ancestry branch.
  private async readEntrySegments(query: EntryQuery) {
    const segments: {
      readonly conversationId: ConversationId
      readonly upper: Option.Option<number>
    }[] = []
    let conversation = await this.readConversation(query.conversationId)
    if (conversation === undefined)
      throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`)
    let upper: Option.Option<number> = Option.fromNullishOr(query.maxEntryId)
    while (true) {
      segments.push({ conversationId: conversation.id, upper })
      if (conversation.parent === undefined) break
      const at = conversation.parent.at
      const bound = Option.match(upper, {
        onNone: () => at,
        onSome: (value) => Math.min(value, at),
      })
      upper = Option.some(bound)
      if (query.minEntryId !== undefined && bound < query.minEntryId) break
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
    return segments
  }

  /** Pi SqliteStorage.task.
   * Return the detached latest task replacement record. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.task.
  async task(id: TaskId, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<ScopedJsonRow>(
        'SELECT id, conversation_id, status, record FROM runtime.tasks WHERE store_id = ? AND id = ?',
        this.storeId,
        id,
      ),
    )
    if (row === undefined) return undefined
    const result = scopedResult(row, {
      decode: taskResult,
      recordKind: 'task',
      status: (task) => task.state.status,
    })
    return Result.getOrThrowWith(result.value, (cause) => cause)
  }

  /** Pi SqliteStorage.scanTasks.
   * Keep filters conjunctive and fetch one extra row in the scan order. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.scanTasks.
  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const start = scanStart(query.order, cursor, 'ascending')
    const scan = scanSql(start)
    const clauses = ['store_id = ?', scan.clause]
    const params: SqlValue[] = [this.storeId, scan.param]
    if (query.conversationId !== undefined) {
      clauses.push('conversation_id = ?')
      params.push(query.conversationId)
    }
    if (query.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(encodeIndexedString(query.kind))
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    if (query.abortRequested !== undefined) {
      clauses.push('abort_requested = ?')
      params.push(query.abortRequested ? 1 : 0)
    }
    if (query.background !== undefined) {
      clauses.push('background = ?')
      params.push(query.background ? 1 : 0)
    }
    params.push(limit + 1)
    const rows = await this.db.all<ScopedJsonRow>(
      `SELECT id, conversation_id, status, record FROM runtime.tasks WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`,
      ...params,
    )
    const decoded = rows.map((row) =>
      scopedResult(row, {
        decode: taskResult,
        recordKind: 'task',
        status: (record) => record.state.status,
      }),
    )
    return page(
      decoded.map((row) => Result.getOrThrow(row.value)),
      limit,
      start.order,
    )
  }

  /** Pi SqliteStorage.submission.
   * Read the latest detached submission receipt. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.submission.
  async submission(id: SubmissionId, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>(
        'SELECT id, record FROM runtime.submissions WHERE store_id = ? AND id = ?',
        this.storeId,
        id,
      ),
    )
    return row === undefined ? undefined : parseSubmission(row.record, row.id)
  }

  /** Pi SqliteStorage.scanSubmissions.
   * Apply filters before the scan-order id limit. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.scanSubmissions.
  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const start = scanStart(query.order, cursor, 'ascending')
    const scan = scanSql(start)
    const clauses = ['store_id = ?', scan.clause]
    const params: SqlValue[] = [this.storeId, scan.param]
    if (query.conversationId !== undefined) {
      clauses.push('conversation_id = ?')
      params.push(query.conversationId)
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    params.push(limit + 1)
    const rows = await this.db.all<ScopedJsonRow>(
      `SELECT id, conversation_id, status, record FROM runtime.submissions WHERE ${clauses.join(' AND ')} ORDER BY id ${scan.direction} LIMIT ?`,
      ...params,
    )
    const decoded = rows.map((row) =>
      scopedResult(row, {
        decode: submissionResult,
        recordKind: 'submission',
        status: (record) => record.status,
      }),
    )
    return page(
      decoded.map((row) => Result.getOrThrow(row.value)),
      limit,
      start.order,
    )
  }

  /** Pi SqliteStorage.submissionByRequest.
   * Preserve conversation-scoped request identities through JSON string encoding. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.submissionByRequest.
  async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>(
        'SELECT id, record FROM runtime.submissions WHERE store_id = ? AND conversation_id = ? AND request_id = ?',
        this.storeId,
        conversationId,
        encodeIndexedString(requestId),
      ),
    )
    return row === undefined ? undefined : parseSubmission(row.record, row.id)
  }

  /** Pi SqliteStorage.findDocument.
   * Resolve exact addresses and half-open incarnation lifetimes without materializing revisions. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.findDocument.
  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context) {
    this.assertOpen()
    const parts = addressParts(address)
    const sql =
      at === 'current'
        ? `SELECT id, record FROM runtime.documents
					WHERE store_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
        : `SELECT id, record FROM runtime.documents
					WHERE store_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`
    const params: SqlValue[] = [
      this.storeId,
      parts.kind,
      parts.scopeKind,
      parts.ownerId,
      parts.family,
      parts.keyValue,
    ]
    if (at !== 'current') params.push(at, at)
    const row = Option.getOrUndefined(await this.db.get<JsonRow>(sql, ...params))
    return row === undefined ? undefined : parseDocument(row.record, row.id)
  }

  /** Pi SqliteStorage.document.
   * PostgreSQL evaluates the record, preceding base and ordered delta tail in
   * one statement snapshot. Pi's SQLite transaction protected three reads; a
   * single PostgreSQL query gives the same snapshot without BEGIN/COMMIT trips. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.document.
  async document(id: DocumentId, at: DocumentPoint, _context: Context) {
    this.assertOpen()
    return this.materializeDocument(this.db, id, at)
  }

  /** Pi SqliteStorage.scanDocuments.
   * Filter exact scope and half-open lifetime before ascending incarnation paging. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.scanDocuments.
  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const scope = scopeColumns(query.scope)
    const clauses = ['store_id = ?', 'scope_kind = ?', 'owner_id = ?', 'id > ?']
    const params: SqlValue[] = [
      this.storeId,
      scope.scopeKind,
      scope.ownerId,
      Option.getOrElse(Option.fromNullishOr(cursorId(cursor)), () => -1),
    ]
    if (query.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(encodeIndexedString(query.kind))
    }
    if (query.at === 'current') {
      clauses.push('retired_at IS NULL')
    } else {
      clauses.push('created_at <= ?', '(retired_at IS NULL OR retired_at > ?)')
      params.push(query.at, query.at)
    }
    params.push(limit + 1)
    const rows = await this.db.all<JsonRow>(
      `SELECT id, record FROM runtime.documents WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseDocument(row.record, row.id)),
      limit,
    )
  }

  /**
   * Pi `SqliteStorage.close`: seal at once, answer every later call with a rejection, and settle
   * when the work already admitted has finished. The shared pool stays open.
   */
  close(_context: Context): Promise<void> {
    if (Option.isSome(this.closing)) return this.closing.value
    this.closed = true
    const closing = this.admitted === 0 ? Promise.resolve() : this.drained.promise
    this.closing = Option.some(closing)
    return closing
  }

  /**
   * Pi `SqliteStorage.admitRead`, widened to commits and reservations: close waits for every
   * operation that issues more than one statement, so none is cut off half done.
   */
  private admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StoreClosed({ storeId: this.storeId }))
    this.admitted++
    return Promise.resolve()
      .then(work)
      .finally(() => {
        if (--this.admitted === 0 && this.closed) this.drained.resolve()
      })
  }

  /**
   * Pi SqliteStorage.readConversation: ancestry traversal reads the original record rather than
   * mirroring parent metadata.
   *
   * A conversation record never changes once committed (Pi `src/types.ts`, `ConversationRecord`;
   * this storage only inserts it), so the store keeps the text of each one it has read and
   * parses it again for every caller, which keeps returned values detached. Only committed rows
   * are kept: nothing is remembered from a write. Without it every ancestry walk and entry scan
   * asks the database again; a reply measured 25 such reads of 66 storage calls.
   */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.readConversation.
  private async readConversation(id: ConversationId) {
    const known = Option.fromNullishOr(this.conversations.get(id))
    if (Option.isSome(known)) return parseConversation(known.value.record, known.value.id)
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>(
        'SELECT id, record FROM runtime.conversations WHERE store_id = ? AND id = ?',
        this.storeId,
        id,
      ),
    )
    if (row === undefined) return undefined
    const record = parseConversation(row.record, row.id)
    this.conversations.set(id, row)
    return record
  }

  /** Pi SqliteStorage.materializeDocument.
   * Replay from the newest preceding base and reject historical reads of current-only documents.
   * A lateral lookup and ordered JSON envelope aggregate replace Pi's three SQL
   * reads with one MVCC snapshot. Only envelope scalars are constructed as JSON;
   * stored record/content TEXT is never parsed by PostgreSQL. BIGINT envelope
   * fields are explicitly text, so JSON decoding cannot lose integer precision.
   * Empty revision tails are real empty arrays; missing bases remain null and
   * retain Pi's rejection after the lifetime/current-only checks. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.materializeDocument.
  private async materializeDocument(
    executor: Pick<Executor, 'get'>,
    id: DocumentId,
    at: DocumentPoint,
  ) {
    const upper = at === 'current' ? Number.MAX_SAFE_INTEGER : at
    const row = Option.getOrUndefined(
      await executor.get<DocumentReadRow>(
        `SELECT d.record,
        CASE WHEN b.seq IS NULL THEN NULL ELSE json_build_object(
          'seq', b.seq::text, 'kind', 'base', 'version', b.version::text, 'content', b.content)::text END AS base,
        COALESCE((SELECT json_agg(json_build_object(
          'seq', r.seq::text, 'kind', r.kind, 'version', r.version::text, 'content', r.content)
          ORDER BY r.seq)::text FROM runtime.document_revisions r
          WHERE r.store_id = d.store_id AND r.document_id = d.id AND r.seq > b.seq AND r.seq <= ?), '[]') AS tail
      FROM runtime.documents d LEFT JOIN LATERAL (
        SELECT seq, version, content FROM runtime.document_revisions
        WHERE store_id = d.store_id AND document_id = d.id AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1
      ) b ON true WHERE d.store_id = ? AND d.id = ?`,
        upper,
        upper,
        this.storeId,
        id,
      ),
    )
    if (row === undefined) return undefined
    const record = parseDocument(row.record, String(id))
    if (at !== 'current' && isCurrentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`)
    }
    if (!isAliveAt(record, at)) return undefined
    if (row.base === null) throw new RevisionsCorrupt({ documentId: id, problem: 'missing base' })
    const base = decodeRevision(row.base, Option.some(String(id)))
    const version = safeNumber(base.version)
    let value = parseObject(base.content, Option.some(String(id)))
    const tail = decodeRevisions(row.tail, Option.some(String(id)))
    for (const revision of tail) {
      if (revision.kind !== 'delta' || safeNumber(revision.version) !== version) {
        throw new RevisionsCorrupt({ documentId: id, problem: 'version boundary' })
      }
      value = apply(value, parseOperations(revision.content, Option.some(String(id))))
    }
    return { record, version, value, deltasSinceBase: tail.length }
  }

  /** Pi SqliteStorage.checkGlobalIds, same checks and order. The pure ownership
   * comparison is split from SQL iteration to meet repository complexity limits. */
  private checkGlobalIds(
    claims: ReturnType<typeof globalClaims>,
    rows: readonly (readonly object[])[],
  ) {
    const claimed = new Map<Id<string>, TableName>()
    for (const [index, claim] of claims.entries()) {
      const rowset = Option.getOrThrow(Option.fromNullishOr(rows[index]))
      const ownership = Option.map(Option.fromNullishOr(rowset[0]), (value) =>
        decodeRecordIdRow(value, Option.some(String(claim.id))),
      )
      checkOwnership(
        claim.id,
        claim.table,
        Option.map(ownership, (row) => row.record_type),
        Option.fromNullishOr(claimed.get(claim.id)),
      )
      claimed.set(claim.id, claim.table)
    }
  }

  /** Pi SqliteStorage prepareDocumentActions. Group commands in
   * insertion order; pure command selection is extracted for complexity lint. */
  private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
    const actions = new Map<DocumentId, DocumentAction>()
    for (const write of writes) {
      switch (write.type) {
        case 'conversation':
        case 'entry':
        case 'task':
        case 'submission':
          break
        case 'document.create':
        case 'document.copy':
        case 'document.change':
        case 'document.retire': {
          const id = documentWriteId(write)
          actions.set(id, withCommand(id, Option.fromNullishOr(actions.get(id)), write))
          break
        }
      }
    }
    return actions
  }

  /** Pi SqliteStorage checkDocumentActions. Validate each command
   * before updating live counts; preserve source reads before destination writes.
   * Separate per-record and delta checks only to satisfy complexity lint. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.checkDocumentActions.
  private async checkDocumentActions(
    executor: Executor,
    actions: ReadonlyMap<DocumentId, DocumentAction>,
  ) {
    const liveCounts = new Map<string, number>()
    for (const [id, action] of actions) {
      if (Predicate.isTagged(action, 'Copy') && actions.has(action.source.id))
        throw new CopySourceChanged({ documentId: id })
      const row = Option.getOrUndefined(
        await executor.get<JsonRow>(
          'SELECT id, record FROM runtime.documents WHERE store_id = ? AND id = ?',
          this.storeId,
          id,
        ),
      )
      const existing = row === undefined ? undefined : parseDocument(row.record, row.id)
      const record = checkDocumentRecord(id, action, Option.fromNullishOr(existing))
      await this.checkDelta(executor, id, action)
      const key = addressKey(record)
      let live = liveCounts.get(key)
      if (live === undefined)
        live = Number((await this.currentDocumentId(executor, record)) !== undefined)
      if (retires(action) && existing !== undefined) live--
      if (Option.isSome(created(action)) && !retires(action)) live++
      liveCounts.set(key, live)
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new AddressOccupied()
    }
  }

  /** Pi SqliteStorage.checkDocumentActions delta branch, unchanged revision lookup
   * and failures; no document materialization or extra SQL is introduced. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.checkDocumentActions delta branch.
  private async checkDelta(executor: Executor, id: DocumentId, action: DocumentAction) {
    if (!Predicate.isTagged(action, 'Change') || action.content.kind !== 'delta') return
    const previous = Option.getOrUndefined(
      await executor.get<{ readonly version: string }>(
        'SELECT version FROM runtime.document_revisions WHERE store_id = ? AND document_id = ? ORDER BY seq DESC LIMIT 1',
        this.storeId,
        id,
      ),
    )
    if (previous === undefined) throw new DeltaWithoutBase({ documentId: id })
    if (safeNumber(previous.version) !== action.content.version)
      throw new VersionWithoutBase({ documentId: id })
  }

  /** Pi SqliteStorage.currentDocumentId.
   * Detect the single current address incarnation using the reference extracted columns. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.currentDocumentId.
  private async currentDocumentId(
    executor: Executor,
    address: DocumentAddress | DocumentCreate | DocumentRecord,
  ) {
    const parts = addressParts(address)
    const row = Option.getOrUndefined(
      await executor.get<IdRow>(
        `SELECT id FROM runtime.documents
				WHERE store_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`,
        this.storeId,
        parts.kind,
        parts.scopeKind,
        parts.ownerId,
        parts.family,
        parts.keyValue,
      ),
    )
    const id = row === undefined ? undefined : row.id
    return id === undefined ? undefined : documentId(safeNumber(id), Option.some(id))
  }

  /** Pi SqliteStorage.applyTableWrite.
   * Preserve write order, id claims and task/submission upserts; nullable fields retain genuine domain absence. */
  private applyTableWrite(executor: Statements, write: StorageWrite, seq: Seq) {
    switch (write.type) {
      case 'conversation':
        this.writeConversation(executor, write.value)
        break
      case 'entry':
        this.writeEntry(executor, write.value, seq)
        break
      case 'task':
        this.claimId(executor, write.value.id, 'task')
        executor.run(
          'task',
          `INSERT INTO runtime.tasks (store_id, id, conversation_id, kind, status, abort_requested, background, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (store_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
          this.storeId,
          write.value.id,
          write.value.conversationId,
          encodeIndexedString(write.value.kind),
          write.value.state.status,
          write.value.abortRequested ? 1 : 0,
          write.value.background ? 1 : 0,
          encodeJson(write.value),
        )
        break
      case 'submission':
        this.claimId(executor, write.value.id, 'submission')
        executor.run(
          'submission',
          `INSERT INTO runtime.submissions (store_id, id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?, ?)
						ON CONFLICT (store_id, id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
          this.storeId,
          write.value.id,
          write.value.conversationId,
          write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
          write.value.status,
          encodeJson(write.value),
        )
        break
      case 'document.create':
      case 'document.copy':
      case 'document.change':
      case 'document.retire':
        break
    }
  }

  /** Pi SqliteStorage.applyTableWrite conversation branch; null means genuinely absent ownership. */
  private writeConversation(executor: Statements, record: ConversationRecord) {
    this.claimId(executor, record.id, 'conversation')
    executor.run(
      'conversation',
      'INSERT INTO runtime.conversations (store_id, id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?, ?)',
      this.storeId,
      record.id,
      record.owner === undefined ? null : record.owner.conversationId,
      record.owner === undefined ? null : record.owner.taskId,
      encodeJson(record),
    )
  }
  /** Pi SqliteStorage.applyTableWrite entry branch; preserve claim-before-insert order. */
  private writeEntry(executor: Statements, record: EntryRecord, seq: Seq) {
    this.claimId(executor, record.id, 'entry')
    executor.run(
      'entry',
      'INSERT INTO runtime.entries (store_id, id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?, ?)',
      this.storeId,
      record.id,
      record.conversationId,
      record.head === undefined ? null : record.head,
      seq,
      encodeJson(record),
    )
  }

  /** Pi SqliteStorage.claimId.
   * PostgreSQL ON CONFLICT DO NOTHING replaces SQLite INSERT OR IGNORE for the shared ownership table. */
  private claimId(executor: Statements, id: Id<string>, table: TableName) {
    executor.run(
      table,
      'INSERT INTO runtime.record_ids (store_id, id, record_type) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      this.storeId,
      id,
      table,
    )
  }

  /** Pi SqliteStorage.applyDocumentActions.
   * Create/claim before revisions, replace current-only bases before insertion,
   * then retire and remove current-only revisions in the reference statement order. */
  // @effect-diagnostics-next-line asyncFunction:off -- Pi Storage Promise contract; port of SqliteStorage.applyDocumentActions.
  private async applyDocumentActions(
    executor: Executor,
    actions: ReadonlyMap<DocumentId, DocumentAction>,
    seq: Seq,
  ) {
    for (const [id, action] of actions) {
      const content: Option.Option<DocumentContent> = DocumentAction.$match(action, {
        Create: (create) => Option.some(create.content),
        Copy: () => Option.none(),
        Change: (change) => Option.some(change.content),
        Retire: () => Option.none(),
      })
      const written = Predicate.isTagged(action, 'Copy')
        ? Option.some(await this.copyContent(executor, id, action))
        : content
      const statements = new Statements()
      const making = created(action)
      let record: DocumentRecord
      if (Option.isSome(making)) {
        const made = { ...making.value, createdAt: seq }
        record = retires(action) ? { ...made, retiredAt: seq } : made
        const parts = addressParts(record)
        this.claimId(statements, id, 'document')
        statements.run(
          'document',
          `INSERT INTO runtime.documents
						(store_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.storeId,
          id,
          parts.kind,
          parts.family,
          parts.keyValue,
          parts.scopeKind,
          parts.ownerId,
          seq,
          retires(action) ? seq : null,
          encodeJson(record),
        )
      } else {
        const row = Option.getOrThrow(
          await executor.get<JsonRow>(
            'SELECT id, record FROM runtime.documents WHERE store_id = ? AND id = ?',
            this.storeId,
            id,
          ),
        )
        record = parseDocument(row.record, row.id)
      }

      if (Option.isSome(written)) {
        const revision = written.value
        if (revision.kind === 'base' && isCurrentOnly(record)) {
          statements.run(
            'document',
            'DELETE FROM runtime.document_revisions WHERE store_id = ? AND document_id = ?',
            this.storeId,
            id,
          )
        }
        const encodedContent = contentJson(revision)
        statements.run(
          'document',
          'INSERT INTO runtime.document_revisions (store_id, document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?, ?)',
          this.storeId,
          id,
          seq,
          revision.kind,
          revision.version,
          encodedContent,
        )
      }

      if (retires(action)) {
        if (Option.isNone(making)) {
          record = { ...record, retiredAt: seq }
          statements.run(
            'document',
            'UPDATE runtime.documents SET retired_at = ?, record = ? WHERE store_id = ? AND id = ?',
            seq,
            encodeJson(record),
            this.storeId,
            id,
          )
        }
        if (isCurrentOnly(record)) {
          statements.run(
            'document',
            'DELETE FROM runtime.document_revisions WHERE store_id = ? AND document_id = ?',
            this.storeId,
            id,
          )
        }
      }
      await executor.runBatch(statements.values)
    }
  }

  /** Pi SqliteStorage applyDocumentActions document.copy branch.
   * Copy validation retains the original request error; other copy failures preserve their cause. */
  private copyContent(
    executor: Executor,
    id: DocumentId,
    action: Extract<DocumentAction, { readonly _tag: 'Copy' }>,
  ) {
    const copy = action.source
    const create = action.record
    return this.materializeDocument(executor, copy.id, copy.at)
      .then((stored) => {
        if (stored === undefined) throw new CopySourceUnreadable({ documentId: copy.id })
        if (
          stored.record.scope.kind !== 'conversation' ||
          create.scope.kind !== 'conversation' ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new CopySourceMismatch({ documentId: copy.id })
        }
        return { kind: 'base' as const, version: stored.version, value: stored.value }
      })
      .catch((cause: unknown) => {
        if (cause instanceof StorageRequestError) throw cause
        throw new CopyRejected({ documentId: id, cause })
      })
  }

  /** Pi SqliteStorage.assertOpen.
   * A sealed storage rejects all later operations even while admitted readers are draining. */
  private assertOpen(): void {
    if (this.closed) throw new StoreClosed({ storeId: this.storeId })
  }
}
