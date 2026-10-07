import type { Context, JsonValue } from '@earendil-works/chord'
import { apply, type Op } from '@earendil-works/chord/delta'
import { StorageRejected } from '@earendil-works/pi-durable'
import * as NodeEvents from 'node:events'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

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
import type {
  PostgresDatabase,
  PostgresExecutor,
  PostgresValue,
  PostgresRecordKind,
  PostgresStatement,
} from './database.ts'
import { safeNumber } from './database.ts'
import { Statements } from './statements.ts'
import { applyPostgresMigrations } from './migrations.ts'

/** Pi src/ids.ts:idFromNumber, numeric brands at the trusted allocation/driver boundary.
 * Repository rules require a schema rather than a runtime typeof check or generic cast. */
const NumericId = Schema.Int
const isNumericId = Schema.is(NumericId)
const entryId = Schema.decodeUnknownSync(
  Schema.declare<EntryId>((value): value is EntryId => isNumericId(value)),
)
const decodeConversationId = Schema.decodeUnknownSync(
  Schema.declare<ConversationId>((value): value is ConversationId => isNumericId(value)),
)
const documentId = Schema.decodeUnknownSync(
  Schema.declare<DocumentId>((value): value is DocumentId => isNumericId(value)),
)
const seqFromNumber = Schema.decodeUnknownSync(
  Schema.declare<Seq>((value): value is Seq => isNumericId(value)),
)

/** Pi src/storage/sqlite/storage.ts:SqliteStorage.candidateNextId/commit ordering, with bigint to retain the exhausted sentinel losslessly. */
function maxId(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}

/** Pi src/storage/sqlite/storage.ts:closeDatabase/admitRead, drain admitted reads
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

/** Pi src/storage/sqlite/storage.ts row/action types; BIGINT driver fields become
 * strings until their checked numeric conversion at the Storage boundary. */
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>
type TableName = Exclude<PostgresRecordKind, 'metadata'>
type JsonRow = { readonly record: string }
type EntryJsonRow = { readonly record: string; readonly commit_seq: string }
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
const decodeRevision = Schema.decodeUnknownSync(Schema.fromJsonString(RevisionWire))
const decodeRevisions = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RevisionWire)))
type IdRow = { readonly id: string }
type MetadataRow = { readonly next_id: string; readonly next_seq: string }
const decodeMetadataRow = Schema.decodeUnknownSync(
  Schema.Struct({ next_id: Schema.String, next_seq: Schema.String }),
)
const decodeRecordIdRow = Schema.decodeUnknownSync(
  Schema.Struct({
    record_type: Schema.Literals(['conversation', 'entry', 'task', 'submission', 'document']),
  }),
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
type DocumentAction = {
  create?: DocumentCreate
  copy?: Extract<StorageWrite, { readonly type: 'document.copy' }>['source']
  content?: DocumentContent
  retire: boolean
}
type ScopeColumns = {
  readonly scopeKind: DocumentRecord['scope']['kind']
  readonly ownerId: number
}

/** Pi src/storage/sqlite/storage.ts:parseJson. Storage trusts its owning Session's
 * record shapes (src/types.ts:Storage); these are reads of that typed writer's JSON,
 * not incoming provider/network payloads. The named JSON codec checks syntax and
 * JSON envelopes without stripping extension fields; Pi still owns payload schemas and transitions.
 * SAFETY: Pi's Storage contract supplies each table's record type; serialization is
 * unchanged JSON text. Only the corresponding reader is used for each table.
 */
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))
const EntryEnvelope = Schema.Struct({
  id: Schema.Number,
  conversationId: Schema.Number,
  kind: Schema.String,
})
const HeadEnvelope = Schema.Struct({ ...EntryEnvelope.fields, head: Schema.Number })
const TaskEnvelope = Schema.Struct({
  ...EntryEnvelope.fields,
  version: Schema.Number,
  background: Schema.Boolean,
  abortRequested: Schema.Boolean,
})
const SubmissionEnvelope = Schema.Struct({ id: Schema.Number, conversationId: Schema.Number })
const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.declare<typeof EntryEnvelope.Type>(Schema.is(EntryEnvelope))),
)
const decodeHead = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.declare<typeof HeadEnvelope.Type>(Schema.is(HeadEnvelope))),
)
const decodeTask = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.declare<typeof TaskEnvelope.Type>(Schema.is(TaskEnvelope))),
)
const decodeSubmission = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.declare<typeof SubmissionEnvelope.Type>(Schema.is(SubmissionEnvelope)),
  ),
)
const Segment = Schema.Union([Schema.String, Schema.Number])
const Path = Schema.Array(Segment)
const NonEmptyPath = Schema.NonEmptyArray(Segment)
const Operations = Schema.Array(
  Schema.Union([
    Schema.Tuple([Schema.Literal('r'), Schema.MutableJson]),
    Schema.Tuple([Schema.Literal('s'), NonEmptyPath, Schema.MutableJson]),
    Schema.Tuple([Schema.Literal('d'), NonEmptyPath]),
    Schema.Tuple([Schema.Literal('a'), NonEmptyPath, Schema.String]),
    Schema.Tuple([Schema.Literal('t'), NonEmptyPath, Schema.Number]),
    Schema.Tuple([
      Schema.Literal('p'),
      Path,
      Schema.Number,
      Schema.Number,
      Schema.mutable(Schema.Array(Schema.MutableJson)),
    ]),
    Schema.Tuple([Schema.Literal('m'), Path, Schema.mutable(Schema.Array(Schema.Number))]),
  ]),
)
/** Pi parseJson<ConversationRecord>: decode the immutable owning Session record. */
const parseConversation = (value: string) => {
  // SAFETY: conversations.record round-trips the owning Session's ConversationRecord.
  return decodeJson(value) as ConversationRecord
}
/** Pi parseJson<EntryRecord>: preserve its application and model payloads unchanged. */
const parseEntry = (value: string) => {
  // SAFETY: entries.record round-trips the owning Session's EntryRecord, including extensions.
  return decodeEntry(value) as EntryRecord
}
/** Pi readLatestHeadMarker: its SQL predicate establishes the required head field. */
const parseHead = (value: string) => {
  // SAFETY: SQL selects only entries where the extracted head column is non-null.
  return decodeHead(value) as EntryRecord & { readonly head: EntryId }
}
/** Pi parseJson<StoredTask>: preserve the complete replacement record supplied by Session. */
const parseTask = (value: string) => {
  // SAFETY: tasks.record round-trips the owning Session's complete TaskRecord.
  return decodeTask(value) as StoredTask
}
/** Pi parseJson<SubmissionRecord>: preserve the receipt state and deduplication payload. */
const parseSubmission = (value: string) => {
  // SAFETY: submissions.record round-trips the owning Session's SubmissionRecord.
  return decodeSubmission(value) as SubmissionRecord
}
/** Pi parseJson<DocumentRecord>: preserve the incarnation lifetime stamped by storage. */
const parseDocument = (value: string) => {
  // SAFETY: documents.record is stamped by this storage from Session-owned DocumentCreate.
  return decodeJson(value) as DocumentRecord
}
/** Pi parseJson<JsonObject>: base content is a JSON object; preserve mutable Chord arrays. */
const parseObject = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
)
const parseOperations = Schema.decodeUnknownSync(Schema.fromJsonString(Operations))

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
/** Pi src/storage/sqlite/storage.ts:encodeIndexedString, retained unchanged.
 * PostgreSQL TEXT rejects NUL and encodes Unicode scalars; JSON string text keeps
 * indexed identities lossless, including NUL and lone UTF-16 surrogates. */
const encodeIndexedString = (value: string): string => JSON.stringify(value)

/** Pi src/storage/sqlite/storage.ts:cursorId. Validate the round-tripped numeric cursor before using it as a SQL bound. */
const cursorId = (cursor: Parameters<Storage['scanTasks']>[2]) => {
  const after = cursor === undefined ? undefined : cursor.after
  if (after === undefined) return undefined
  if (!isNumericId(after)) throw new TypeError('Invalid storage cursor')
  return after
}

/** Pi src/storage/sqlite/storage.ts:page. The extra row determines continuation; the last returned id is its cursor. */
const page = <T extends { readonly id: Id<string> }>(
  values: readonly T[],
  limit: number,
): Page<T, Cursor> => {
  const items = values.slice(0, limit)
  if (values.length <= limit) return { items }
  return { items, next: { after: Option.getOrThrow(Option.fromNullishOr(items.at(-1))).id } }
}

/** Pi src/storage/sqlite/storage.ts:scopeColumns. Session ownership uses reserved zero; other scopes use their actual owner id. */
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

/** Pi src/storage/sqlite/storage.ts:addressParts. Family presence distinguishes a singleton from the empty-string key; this is not a fallback identity. */
const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
  const scope = scopeColumns(address.scope)
  return {
    kind: encodeIndexedString(address.kind),
    ...scope,
    family: address.key === undefined ? 0 : 1,
    keyValue: encodeIndexedString(address.key === undefined ? '' : address.key),
  }
}

/** Pi src/storage/sqlite/storage.ts:addressKey. One exact address key combines scope, kind and family identity during batch validation. */
const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
  const parts = addressParts(address)
  return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue])
}

/** Pi src/storage/sqlite/storage.ts:isAliveAt. Creation is inclusive and retirement exclusive; current reads see only live incarnations. */
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === 'current') return record.retiredAt === undefined
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt)
}

/** Pi src/storage/sqlite/storage.ts:isCurrentOnly. Only rewindable conversation documents retain historical bases and deltas. */
const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== 'conversation' || record.history === 'latest'

/** Pi src/storage/sqlite/storage.ts:writeId. Changes and retirement do not allocate ids; creation and table replacement writes may advance the watermark. */
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
    throw new Error(`ID ${id} already belongs to ${existing.value}`)
  if (Option.isNone(earlier)) return
  if (immutable) throw new Error(`ID ${id} is written more than once`)
  if (earlier.value !== table) throw new Error(`ID ${id} is written as two record types`)
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
/** Pi SqliteStorage.prepareDocumentActions, same content-command conflicts and
 * retirement ordering. Extracted pure selection satisfies the complexity limit. */
function selectDocumentAction(id: DocumentId, action: DocumentAction, write: DocumentWrite) {
  switch (write.type) {
    case 'document.create':
    case 'document.copy':
      checkNewContent(id, action)
      action.create = write.record
      if (write.type === 'document.create') action.content = write.content
      else action.copy = write.source
      break
    case 'document.change':
      if (action.content !== undefined || action.copy !== undefined)
        throw new Error(`Document ${id} has more than one content command`)
      action.content = write.content
      break
    case 'document.retire':
      if (action.retire) throw new Error(`Document ${id} is retired more than once`)
      action.retire = true
      break
    default:
      exhaustive(write)
  }
}
/** Pi prepareDocumentActions create/copy invariant, retained before adopting the new command. */
function checkNewContent(id: DocumentId, action: DocumentAction) {
  if (action.create !== undefined || action.content !== undefined || action.copy !== undefined)
    throw new Error(`Document ${id} has more than one content command`)
}
/** Pi checkDocumentActions existence/retirement branch. Explicit Option replaces
 * its non-null assertion without changing any reachable rejection. */
function checkDocumentRecord(
  id: DocumentId,
  action: DocumentAction,
  existing: Option.Option<DocumentRecord>,
) {
  if (action.create === undefined && Option.isNone(existing))
    throw new Error(`Unknown document: ${id}`)
  if (action.create !== undefined && Option.isSome(existing))
    throw new Error(`Document ${id} already exists`)
  if (Option.isSome(existing) && existing.value.retiredAt !== undefined)
    throw new Error(`Document ${id} is retired`)
  return action.create ?? Option.getOrThrow(existing)
}

/** Port of Pi src/storage/sqlite/storage.ts:SqliteStorage and src/types.ts:Storage.
 * Statement order, paging, document revisions and close admission follow Pi 1.0.4.
 * Option is plain facade data; all Pi return types retain their original absence.
 * BIGINT metadata preserves the exhausted id sentinel and checks driver text before
 * returning Pi numeric brands. PostgreSQL errors identify this backend, while all
 * domain rejection messages are retained. ON CONFLICT replaces INSERT OR IGNORE.
 */
export class PostgresStorage implements Storage {
  private readonly db: PostgresDatabase
  private nextId: bigint
  private closed = false
  private closing?: Promise<void>
  private admittedReads = 0
  private readonly drained = drainSignal()

  /** Pi SqliteStorage.constructor: initialize only the volatile watermark; the database remains authoritative for commits. */
  private constructor(db: PostgresDatabase, nextId: bigint) {
    this.db = db
    this.nextId = nextId
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.open. The supplied facade must
   * already target this schema, as openPgDatabase does; driver connection setup
   * stays outside the storage SQL core. Preserve the initial error
   * even if cleanup fails. Promise handlers replace catch blocks for repository lint. */
  static open(db: PostgresDatabase, schema: string): Promise<PostgresStorage> {
    return applyPostgresMigrations(db, schema)
      .then(() =>
        db.get<MetadataRow>('SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1'),
      )
      .then((metadata) => {
        if (Option.isNone(metadata)) throw new Error('Durable PostgreSQL metadata is missing')
        return new PostgresStorage(db, BigInt(metadata.value.next_id))
      })
      .catch((cause: unknown) =>
        db.close().then(
          () => {
            throw cause
          },
          () => {
            throw cause
          },
        ),
      )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.commit.
   * Allocate the sequence only inside the transaction, and advance the volatile id watermark only after commit.
   * PostgreSQL transports BEGIN and independent metadata/ownership reads as one
   * ordered batch, then transports each contiguous write segment as one batch.
   * Unlike multi-row inserts, every claim/upsert retains its original position;
   * repeated mutable ids and the first database failure retain Pi's behavior.
   * Domain checks consume prefetched read results in the reference order; later
   * read-only ownership lookups have no effects when an earlier check rejects.
   * Conditional document reads/copy errors keep their original write barriers.
   * The final segment is prepared for the driver to send with COMMIT, so a plain
   * append needs only the allocation/preflight response and the durable commit response. */
  async commit(writes: readonly StorageWrite[], _context: Context) {
    this.assertOpen()
    const documentActions = this.prepareDocumentActions(writes)
    const candidateNextId = this.candidateNextId(writes)
    const claims = globalClaims(writes)
    const reads: PostgresStatement[] = [
      {
        recordKind: 'metadata',
        sql: 'SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1',
        params: [],
      },
      ...claims.map((claim) => ({
        recordKind: claim.table,
        sql: 'SELECT record_type FROM record_ids WHERE id = ?',
        params: [claim.id],
      })),
    ]
    const seq = await this.db.transactionWithReads(reads, async (transaction, rows) => {
      const metadataRows = Option.getOrThrow(Option.fromNullishOr(rows[0]))
      const metadataRow = Option.fromNullishOr(metadataRows[0])
      if (Option.isNone(metadataRow)) throw new Error('Durable PostgreSQL metadata is missing')
      const metadata = decodeMetadataRow(metadataRow.value)
      const committedSeq = seqFromNumber(safeNumber(metadata.next_seq))
      this.checkGlobalIds(claims, rows.slice(1))
      await this.checkDocumentActions(transaction, documentActions)
      const statements = new Statements()
      for (const write of writes) this.applyTableWrite(statements, write, committedSeq)
      if (documentActions.size > 0) {
        if (statements.values.length > 0) await transaction.runBatch(statements.values)
        statements.values.length = 0
        await this.applyDocumentActions(transaction, documentActions, committedSeq)
      }
      statements.run(
        'metadata',
        'UPDATE durable_metadata SET next_id = ?, next_seq = ? WHERE singleton = 1',
        String(maxId(BigInt(metadata.next_id), candidateNextId)),
        BigInt(committedSeq) + 1n,
      )
      return { value: committedSeq, statements: statements.values }
    })
    this.nextId = maxId(this.nextId, candidateNextId)
    return seq
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.mintId.
   * Candidate minting is volatile until a write commits its watermark; preserve the exhausted-space rejection. */
  async mintId<I extends Id<string>>(): Promise<I> {
    this.assertOpen()
    if (this.nextId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ID space is exhausted')
    // SAFETY: safe numeric candidate belongs to Pi's single global namespace; its brand is erased.
    return Number(this.nextId++) as I
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.conversation.
   * Return a detached exact record without following ancestry. */
  async conversation(id: ConversationId, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>('SELECT record FROM conversations WHERE id = ?', id),
    )
    return row === undefined ? undefined : parseConversation(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.scanConversations.
   * Use the original ascending id cursor and fetch limit plus one for continuation. */
  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const clauses = ['id > ?']
    const params: PostgresValue[] = [cursorId(cursor) ?? -1]
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
      `SELECT record FROM conversations WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseConversation(row.record)),
      limit,
    )
  }

  entry(id: EntryId, context: Context): ReturnType<Storage['entry']>
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage['entry']>
  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.entry.
   * Keep both global lookup and ancestry-filtered overloads behind read admission. */
  entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ) {
    return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context))
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.findLatestHeadMarker.
   * Read admission keeps ancestry traversal alive while close waits for its later SQL. */
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: Parameters<Storage['findLatestHeadMarker']>[1],
    _context: Context,
  ) {
    return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId))
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.scanEntries.
   * Newest-first fork paging uses the original inclusive ancestry cutoffs. */
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.admitRead(() => this.readEntries(query, limit, cursor))
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.readEntry.
   * An ancestry lookup hides entries beyond the parent fork cutoff and returns the stored commit sequence. */
  private async readEntry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ) {
    const id =
      context === undefined
        ? entryId(idOrConversationId)
        : isNumericId(idOrContext)
          ? entryId(idOrContext)
          : undefined
    if (id === undefined) throw new TypeError('Storage.entry() requires an entry ID')
    if (context !== undefined)
      return this.readScopedEntry(decodeConversationId(idOrConversationId), id)
    const row = Option.getOrUndefined(
      await this.db.get<EntryJsonRow>('SELECT record, commit_seq FROM entries WHERE id = ?', id),
    )
    if (row === undefined) return undefined
    const entry = parseEntry(row.record)
    return { entry, commitSeq: seqFromNumber(safeNumber(row.commit_seq)) }
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.readEntry scoped overload.
   * Walk immutable conversation ancestry in JavaScript exactly as the reference
   * does. PostgreSQL json extraction de-escapes the entire record, rejecting JSON
   * extensions containing escaped NUL or lone UTF16 surrogates. Reading only TEXT
   * preserves those values; this costs one indexed read per ancestor instead of
   * the previous recursive SQL query. No explicit transaction is needed because
   * ancestry and entries are immutable (Pi src/types.ts:Storage). */
  private async readScopedEntry(conversationId: ConversationId, id: EntryId) {
    let conversation = await this.readConversation(conversationId)
    if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`)
    const row = Option.getOrUndefined(
      await this.db.get<EntryJsonRow>('SELECT record, commit_seq FROM entries WHERE id = ?', id),
    )
    if (row === undefined) return undefined
    const entry = parseEntry(row.record)
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
    return { entry, commitSeq: seqFromNumber(safeNumber(row.commit_seq)) }
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.readLatestHeadMarker.
   * Find the newest visible marker before descending into parent ancestry. */
  private async readLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: Parameters<Storage['findLatestHeadMarker']>[1],
  ) {
    let conversation = await this.readConversation(conversationId)
    if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`)
    let upper: ReturnType<typeof cursorId> = atOrBeforeEntryId
    while (true) {
      const row =
        upper === undefined
          ? Option.getOrUndefined(
              await this.db.get<JsonRow>(
                'SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1',
                conversation.id,
              ),
            )
          : Option.getOrUndefined(
              await this.db.get<JsonRow>(
                'SELECT record FROM entries WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1',
                conversation.id,
                upper,
              ),
            )
      if (row !== undefined) return parseHead(row.record)
      if (conversation.parent === undefined) return undefined
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.readEntries.
   * Fill one page across ancestor segments without exposing entries beyond their inclusive fork cutoffs. */
  private async readEntries(
    query: EntryQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
  ) {
    let conversation = await this.readConversation(query.conversationId)
    if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`)
    const after = cursorId(cursor)
    let upper: ReturnType<typeof cursorId> = query.maxEntryId
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1)
    const values: EntryRecord[] = []
    while (true) {
      const clauses = ['conversation_id = ?']
      const params: PostgresValue[] = [conversation.id]
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
        `SELECT record FROM entries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        ...params,
      )
      values.push(...rows.map((row) => parseEntry(row.record)))
      if (values.length > limit || conversation.parent === undefined) break
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at)
      if (query.minEntryId !== undefined && upper < query.minEntryId) break
      conversation = Option.getOrThrow(
        Option.fromNullishOr(await this.readConversation(conversation.parent.conversationId)),
      )
    }
    return page(values, limit)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.task.
   * Return the detached latest task replacement record. */
  async task(id: TaskId, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>('SELECT record FROM tasks WHERE id = ?', id),
    )
    return row === undefined ? undefined : parseTask(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.scanTasks.
   * Keep every supplied filter conjunctive and fetch one extra row for ascending continuation. */
  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const clauses = ['id > ?']
    const params: PostgresValue[] = [cursorId(cursor) ?? -1]
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
    const rows = await this.db.all<JsonRow>(
      `SELECT record FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseTask(row.record)),
      limit,
    )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.submission.
   * Read the latest detached submission receipt. */
  async submission(id: SubmissionId, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>('SELECT record FROM submissions WHERE id = ?', id),
    )
    return row === undefined ? undefined : parseSubmission(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.scanSubmissions.
   * Apply status and conversation filters before the ascending id limit. */
  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const clauses = ['id > ?']
    const params: PostgresValue[] = [cursorId(cursor) ?? -1]
    if (query.conversationId !== undefined) {
      clauses.push('conversation_id = ?')
      params.push(query.conversationId)
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    params.push(limit + 1)
    const rows = await this.db.all<JsonRow>(
      `SELECT record FROM submissions WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseSubmission(row.record)),
      limit,
    )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.submissionByRequest.
   * Preserve conversation-scoped request identities through JSON string encoding. */
  async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context) {
    this.assertOpen()
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>(
        'SELECT record FROM submissions WHERE conversation_id = ? AND request_id = ?',
        conversationId,
        encodeIndexedString(requestId),
      ),
    )
    return row === undefined ? undefined : parseSubmission(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.findDocument.
   * Resolve exact addresses and half-open incarnation lifetimes without materializing revisions. */
  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context) {
    this.assertOpen()
    const parts = addressParts(address)
    const sql =
      at === 'current'
        ? `SELECT record FROM documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
        : `SELECT record FROM documents
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`
    const params: PostgresValue[] = [
      parts.kind,
      parts.scopeKind,
      parts.ownerId,
      parts.family,
      parts.keyValue,
    ]
    if (at !== 'current') params.push(at, at)
    const row = Option.getOrUndefined(await this.db.get<JsonRow>(sql, ...params))
    return row === undefined ? undefined : parseDocument(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.document.
   * PostgreSQL evaluates the record, preceding base and ordered delta tail in
   * one statement snapshot. Pi's SQLite transaction protected three reads; a
   * single PostgreSQL query gives the same snapshot without BEGIN/COMMIT trips. */
  async document(id: DocumentId, at: DocumentPoint, _context: Context) {
    this.assertOpen()
    return this.materializeDocument(this.db, id, at)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.scanDocuments.
   * Filter exact scope and half-open lifetime before ascending incarnation paging. */
  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Parameters<Storage['scanTasks']>[2],
    _context: Context,
  ) {
    this.assertOpen()
    const scope = scopeColumns(query.scope)
    const clauses = ['scope_kind = ?', 'owner_id = ?', 'id > ?']
    const params: PostgresValue[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1]
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
      `SELECT record FROM documents WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    return page(
      rows.map((row) => parseDocument(row.record)),
      limit,
    )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.close.
   * Seal admission immediately and return the same closing promise on repeated closes. */
  close(_context: Context): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true
      this.closing = this.closeDatabase()
    }
    return this.closing
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.closeDatabase.
   * Wait for admitted multi-query readers before handing close to the queued database. */
  private async closeDatabase() {
    if (this.admittedReads > 0) {
      await this.drained.promise
    }
    await this.db.close()
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.admitRead.
   * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
   * closed database. Single-query reads and transactions are already ordered before close by the database.
   */
  private async admitRead<T>(read: () => Promise<T>) {
    this.assertOpen()
    this.admittedReads++
    try {
      return await read()
    } finally {
      if (--this.admittedReads === 0 && this.closed) this.drained.resolve()
    }
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.readConversation.
   * Ancestry traversal reads the original record rather than mirroring parent metadata. */
  private async readConversation(id: ConversationId) {
    const row = Option.getOrUndefined(
      await this.db.get<JsonRow>('SELECT record FROM conversations WHERE id = ?', id),
    )
    return row === undefined ? undefined : parseConversation(row.record)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.materializeDocument.
   * Replay from the newest preceding base and reject historical reads of current-only documents.
   * A lateral lookup and ordered JSON envelope aggregate replace Pi's three SQL
   * reads with one MVCC snapshot. Only envelope scalars are constructed as JSON;
   * stored record/content TEXT is never parsed by PostgreSQL. BIGINT envelope
   * fields are explicitly text, so JSON decoding cannot lose integer precision.
   * Empty revision tails are real empty arrays; missing bases remain null and
   * retain Pi's rejection after the lifetime/current-only checks. */
  private async materializeDocument(executor: PostgresExecutor, id: DocumentId, at: DocumentPoint) {
    const upper = at === 'current' ? Number.MAX_SAFE_INTEGER : at
    const row = Option.getOrUndefined(
      await executor.get<DocumentReadRow>(
        `SELECT d.record,
        CASE WHEN b.seq IS NULL THEN NULL ELSE json_build_object(
          'seq', b.seq::text, 'kind', 'base', 'version', b.version::text, 'content', b.content)::text END AS base,
        COALESCE((SELECT json_agg(json_build_object(
          'seq', r.seq::text, 'kind', r.kind, 'version', r.version::text, 'content', r.content)
          ORDER BY r.seq)::text FROM document_revisions r
          WHERE r.document_id = d.id AND r.seq > b.seq AND r.seq <= ?), '[]') AS tail
      FROM documents d LEFT JOIN LATERAL (
        SELECT seq, version, content FROM document_revisions
        WHERE document_id = d.id AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1
      ) b ON true WHERE d.id = ?`,
        upper,
        upper,
        id,
      ),
    )
    if (row === undefined) return undefined
    const record = parseDocument(row.record)
    if (at !== 'current' && isCurrentOnly(record)) {
      throw new Error(`Document ${id} does not retain historical content`)
    }
    if (!isAliveAt(record, at)) return undefined
    if (row.base === null) throw new Error(`Document ${id} is missing a required base`)
    const base = decodeRevision(row.base)
    const version = safeNumber(base.version)
    let value = parseObject(base.content)
    const tail = decodeRevisions(row.tail)
    for (const revision of tail) {
      if (revision.kind !== 'delta' || safeNumber(revision.version) !== version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`)
      }
      value = apply(value, parseOperations(revision.content))
    }
    return { record, version, value, deltasSinceBase: tail.length }
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.candidateNextId.
   * Only created record ids advance the watermark; bigint retains the sentinel beyond the last safe candidate. */
  private candidateNextId(writes: readonly StorageWrite[]): bigint {
    let nextId = this.nextId
    for (const write of writes) {
      const id = writeId(write)
      if (id !== undefined) nextId = maxId(nextId, BigInt(id) + 1n)
    }
    return nextId
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
      const ownership = Option.map(Option.fromNullishOr(rowset[0]), decodeRecordIdRow)
      checkOwnership(
        claim.id,
        claim.table,
        Option.map(ownership, (row) => row.record_type),
        Option.fromNullishOr(claimed.get(claim.id)),
      )
      claimed.set(claim.id, claim.table)
    }
  }

  /** Pi src/storage/sqlite/storage.ts:prepareDocumentActions. Group commands in
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
          const action = actions.get(id) ?? { retire: false }
          selectDocumentAction(id, action, write)
          actions.set(id, action)
          break
        }
      }
    }
    return actions
  }

  /** Pi src/storage/sqlite/storage.ts:checkDocumentActions. Validate each command
   * before updating live counts; preserve source reads before destination writes.
   * Separate per-record and delta checks only to satisfy complexity lint. */
  private async checkDocumentActions(
    executor: PostgresExecutor,
    actions: ReadonlyMap<DocumentId, DocumentAction>,
  ) {
    const liveCounts = new Map<string, number>()
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id))
        throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`)
      const row = Option.getOrUndefined(
        await executor.get<JsonRow>('SELECT record FROM documents WHERE id = ?', id),
      )
      const existing = row === undefined ? undefined : parseDocument(row.record)
      const record = checkDocumentRecord(id, action, Option.fromNullishOr(existing))
      await this.checkDelta(executor, id, action)
      const key = addressKey(record)
      let live = liveCounts.get(key)
      if (live === undefined)
        live = Number((await this.currentDocumentId(executor, record)) !== undefined)
      if (action.retire && existing !== undefined) live--
      if (action.create !== undefined && !action.retire) live++
      liveCounts.set(key, live)
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error('Document address already has a current incarnation')
    }
  }

  /** Pi SqliteStorage.checkDocumentActions delta branch, unchanged revision lookup
   * and failures; no document materialization or extra SQL is introduced. */
  private async checkDelta(executor: PostgresExecutor, id: DocumentId, action: DocumentAction) {
    if (action.content === undefined || action.content.kind !== 'delta') return
    const previous = Option.getOrUndefined(
      await executor.get<{ readonly version: string }>(
        'SELECT version FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1',
        id,
      ),
    )
    if (previous === undefined) throw new Error(`Document ${id} delta has no base`)
    if (safeNumber(previous.version) !== action.content.version)
      throw new Error(`Document ${id} version transition requires a base`)
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.currentDocumentId.
   * Detect the single current address incarnation using the reference extracted columns. */
  private async currentDocumentId(
    executor: PostgresExecutor,
    address: DocumentAddress | DocumentCreate | DocumentRecord,
  ) {
    const parts = addressParts(address)
    const row = Option.getOrUndefined(
      await executor.get<IdRow>(
        `SELECT id FROM documents
				WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`,
        parts.kind,
        parts.scopeKind,
        parts.ownerId,
        parts.family,
        parts.keyValue,
      ),
    )
    const id = row === undefined ? undefined : row.id
    return id === undefined ? undefined : documentId(safeNumber(id))
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.applyTableWrite.
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
          `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
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
          `INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
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
      'INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)',
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
      'INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)',
      record.id,
      record.conversationId,
      record.head === undefined ? null : record.head,
      seq,
      encodeJson(record),
    )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.claimId.
   * PostgreSQL ON CONFLICT DO NOTHING replaces SQLite INSERT OR IGNORE for the shared ownership table. */
  private claimId(executor: Statements, id: Id<string>, table: TableName) {
    executor.run(
      table,
      'INSERT INTO record_ids (id, record_type) VALUES (?, ?) ON CONFLICT DO NOTHING',
      id,
      table,
    )
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.applyDocumentActions.
   * Create/claim before revisions, replace current-only bases before insertion,
   * then retire and remove current-only revisions in the reference statement order. */
  private async applyDocumentActions(
    executor: PostgresExecutor,
    actions: ReadonlyMap<DocumentId, DocumentAction>,
    seq: Seq,
  ) {
    for (const [id, action] of actions) {
      let content = action.content
      if (action.copy !== undefined) content = await this.copyContent(executor, id, action)
      const statements = new Statements()
      let record: DocumentRecord
      if (action.create !== undefined) {
        const created = { ...action.create, createdAt: seq }
        record = action.retire ? { ...created, retiredAt: seq } : created
        const parts = addressParts(record)
        this.claimId(statements, id, 'document')
        statements.run(
          'document',
          `INSERT INTO documents
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          parts.kind,
          parts.family,
          parts.keyValue,
          parts.scopeKind,
          parts.ownerId,
          seq,
          action.retire ? seq : null,
          encodeJson(record),
        )
      } else {
        const row = Option.getOrThrow(
          await executor.get<JsonRow>('SELECT record FROM documents WHERE id = ?', id),
        )
        record = parseDocument(row.record)
      }

      if (content !== undefined) {
        if (content.kind === 'base' && isCurrentOnly(record)) {
          statements.run('document', 'DELETE FROM document_revisions WHERE document_id = ?', id)
        }
        const encodedContent = contentJson(content)
        statements.run(
          'document',
          'INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)',
          id,
          seq,
          content.kind,
          content.version,
          encodedContent,
        )
      }

      if (action.retire) {
        if (action.create === undefined) {
          record = { ...record, retiredAt: seq }
          statements.run(
            'document',
            'UPDATE documents SET retired_at = ?, record = ? WHERE id = ?',
            seq,
            encodeJson(record),
            id,
          )
        }
        if (isCurrentOnly(record)) {
          statements.run('document', 'DELETE FROM document_revisions WHERE document_id = ?', id)
        }
      }
      await executor.runBatch(statements.values)
    }
  }

  /** Pi src/storage/sqlite/storage.ts:applyDocumentActions document.copy branch.
   * Promise rejection handlers retain StorageRejected while satisfying no-try-catch. */
  private copyContent(executor: PostgresExecutor, id: DocumentId, action: DocumentAction) {
    const copy = Option.getOrThrow(Option.fromNullishOr(action.copy))
    return this.materializeDocument(executor, copy.id, copy.at)
      .then((stored) => {
        if (stored === undefined) throw new Error(`Fork source document ${copy.id} cannot be read`)
        const create = Option.getOrThrow(Option.fromNullishOr(action.create))
        if (
          stored.record.scope.kind !== 'conversation' ||
          create.scope.kind !== 'conversation' ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new Error(`Fork source document ${copy.id} does not match the copied record`)
        }
        return { kind: 'base' as const, version: stored.version, value: stored.value }
      })
      .catch((cause: unknown) => {
        if (cause instanceof StorageRejected) throw cause
        throw new StorageRejected(`Document copy ${id} was rejected`, { cause })
      })
  }

  /** Pi src/storage/sqlite/storage.ts:SqliteStorage.assertOpen.
   * A sealed storage rejects all later operations even while admitted readers are draining. */
  private assertOpen(): void {
    if (this.closed) throw new Error('PostgresStorage is closed')
  }
}
