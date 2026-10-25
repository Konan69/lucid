import { Predicate, Schema } from 'effect'
import type { ConversationId } from '@earendil-works/pi-durable'

/**
 * Pi's record kinds (`src/types.ts`, `StorageWrite`), plus `metadata` for the allocator's own SQL.
 * One closed vocabulary for failures and for the statements that carry a record kind.
 */
export const RecordKind = Schema.Literals([
  'conversation',
  'entry',
  'task',
  'submission',
  'document',
  'metadata',
])

const ConversationNumber = Schema.declare<ConversationId>(
  (value): value is ConversationId =>
    Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0,
)

/**
 * A stored row failed its envelope or identity check. The table and id are kept; the stored
 * value and Schema's rendering of it are not, because a record can quote a Person's prompt.
 */
export class StorageInvalid extends Schema.TaggedError<StorageInvalid>()(
  'StorageInvalid',
  {
    recordKind: RecordKind,
    recordId: Schema.optionalKey(Schema.String),
    conversationId: Schema.optionalKey(ConversationNumber),
  },
  { title: 'Stored conversation record is invalid' },
) {
  override get message() {
    return `Conversation store ${this.recordKind} record${this.recordId === undefined ? '' : ` ${this.recordId}`} is invalid`
  }
}

/**
 * Statements reach PostgreSQL as literal text (`driver.ts`), which cannot carry a raw NUL. Pi's
 * JSON escapes NUL, so this only meets a value that was never JSON text; it is refused before it
 * can cut a statement short.
 */
export class RawNul extends Schema.TaggedError<RawNul>()(
  'RawNul',
  { recordKind: RecordKind },
  { title: 'Value contains a raw NUL character' },
) {
  override get message() {
    return `Conversation store ${this.recordKind} value contains a raw NUL character`
  }
}

/**
 * Literal statements are safe only on a UTF8 connection, where a multibyte character cannot
 * swallow an escaping backslash. The runtime refuses another setting; it never changes it.
 */
export class ConnectionSettingInvalid extends Schema.TaggedError<ConnectionSettingInvalid>()(
  'ConnectionSettingInvalid',
  {
    setting: Schema.Literals(['client_encoding', 'standard_conforming_strings']),
    value: Schema.String,
  },
  { title: 'Database connection setting is not supported' },
) {}

/**
 * Another runtime process holds the conversations (its control connection holds the advisory
 * lock). Pi allows one owner per store and every store belongs to the one runtime, so this
 * process opens nothing and stops; the platform starts it again.
 */
export class RuntimeOwned extends Schema.TaggedError<RuntimeOwned>()(
  'RuntimeOwned',
  {},
  { title: 'Another runtime process holds the conversations' },
) {}

/**
 * The database does not have this runtime's tables yet: the newest migration this code ships
 * (`drizzle/`) is not in the runtime's ledger (`ledger.ts`). The runtime service migrates in its
 * own pre-deploy step before the process starts (`infra/railway.ts`), so in production this means
 * that step did not run or did not finish; locally, `pnpm db:migrate` has not been run. The
 * process opens nothing, changes nothing and stops non-zero. It never migrates and never waits.
 */
export class MigrationsPending extends Schema.TaggedError<MigrationsPending>()(
  'MigrationsPending',
  { expected: Schema.String },
  { title: 'The runtime’s tables are not migrated yet' },
) {
  override get message() {
    return `The database has not applied the runtime migration ${this.expected}; run the runtime's migrations (pnpm --filter @vivid/agent-runtime db:migrate) first`
  }
}

/**
 * A write was refused because a newer runtime has taken the conversations: the owner row's
 * generation is no longer the one this process took. Nothing of the transaction was written.
 */
export class OwnershipLost extends Schema.TaggedError<OwnershipLost>()(
  'OwnershipLost',
  { held: Schema.String, current: Schema.String },
  { title: 'A newer runtime owns the conversations' },
) {
  override get message() {
    return `This runtime holds generation ${this.held}; the conversations now belong to generation ${this.current}`
  }
}

/**
 * The control connection, which holds the advisory lock, ended. Nothing this process writes
 * after a successor takes over can land (`OwnershipLost`), and it must not keep serving from
 * what it has cached, so it stops and the platform starts a fresh one.
 */
export class ControlLost extends Schema.TaggedError<ControlLost>()(
  'ControlLost',
  {},
  { title: 'The runtime lost its control connection' },
) {}

/**
 * PostgreSQL answered a batch with something other than one result per statement. The driver's
 * answer is unknown input; it is checked once, here, before any row is read.
 */
export class ResultInvalid extends Schema.TaggedError<ResultInvalid>()(
  'ResultInvalid',
  {},
  { title: 'Database answered with an unexpected result' },
) {}

/** A Person's store could not be found, made or listed: the database refused or was unreachable. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  'StoreUnavailable',
  { cause: Schema.Defect() },
  { title: 'Conversation store is unavailable' },
) {}

/**
 * The store's own rows are missing: no `runtime.metadata` row for a store that was opened. A
 * store is made with its metadata in one write (`stores.ts`), so this is a store that was never
 * made or was damaged; it is refused rather than started from nothing.
 */
export class StoreMissing extends Schema.TaggedError<StoreMissing>()(
  'StoreMissing',
  { storeId: Schema.String },
  { title: 'Conversation store has no metadata' },
) {
  override get message() {
    return `Conversation store ${this.storeId} has no metadata`
  }
}

/** A call reached a store after `close` (Pi `Storage.close`: all later operations reject). */
export class StoreClosed extends Schema.TaggedError<StoreClosed>()(
  'StoreClosed',
  { storeId: Schema.String },
  { title: 'Conversation store is closed' },
) {
  override get message() {
    return `PostgresStore ${this.storeId} is closed`
  }
}

/** The store has handed out every safe integer id (Pi `SqliteStorage.mintId`'s refusal). */
export class IdsExhausted extends Schema.TaggedError<IdsExhausted>()(
  'IdsExhausted',
  { storeId: Schema.String },
  { title: 'Conversation store id space is exhausted' },
) {
  override get message() {
    return 'ID space is exhausted'
  }
}

/*
 * A batch Pi's reference storage refuses (`SqliteStorage.checkGlobalIds`, `prepareDocumentActions`,
 * `checkDocumentActions`). Each is its own tag with the record it names; the messages are the
 * reference's, which Pi's conformance suite reads. Nothing of a refused batch is written.
 */

/** An id already owned by a record that cannot be replaced, or by another kind. */
export class IdTaken extends Schema.TaggedError<IdTaken>()(
  'IdTaken',
  { id: Schema.Int, owner: Schema.String },
  { title: 'Record id already belongs to another record' },
) {
  override get message() {
    return `ID ${this.id} already belongs to ${this.owner}`
  }
}

/** An immutable record written twice in one batch. */
export class IdRepeated extends Schema.TaggedError<IdRepeated>()(
  'IdRepeated',
  { id: Schema.Int },
  { title: 'Record id written twice in one batch' },
) {
  override get message() {
    return `ID ${this.id} is written more than once`
  }
}

/** One id written as two record kinds in one batch. */
export class IdKindsDiffer extends Schema.TaggedError<IdKindsDiffer>()(
  'IdKindsDiffer',
  { id: Schema.Int },
  { title: 'Record id written as two kinds' },
) {
  override get message() {
    return `ID ${this.id} is written as two record types`
  }
}

/** A document given two content commands (create, copy, change) in one batch. */
export class DocumentContentRepeated extends Schema.TaggedError<DocumentContentRepeated>()(
  'DocumentContentRepeated',
  { documentId: Schema.Int },
  { title: 'Document has more than one content command' },
) {
  override get message() {
    return `Document ${this.documentId} has more than one content command`
  }
}

/** A document retired twice in one batch. */
export class DocumentRetiredTwice extends Schema.TaggedError<DocumentRetiredTwice>()(
  'DocumentRetiredTwice',
  { documentId: Schema.Int },
  { title: 'Document retired more than once' },
) {
  override get message() {
    return `Document ${this.documentId} is retired more than once`
  }
}

/** A change or retirement of a document this store does not have. */
export class DocumentUnknown extends Schema.TaggedError<DocumentUnknown>()(
  'DocumentUnknown',
  { documentId: Schema.Int },
  { title: 'Document is unknown' },
) {
  override get message() {
    return `Unknown document: ${this.documentId}`
  }
}

/** A create or copy of a document id that already exists. */
export class DocumentExists extends Schema.TaggedError<DocumentExists>()(
  'DocumentExists',
  { documentId: Schema.Int },
  { title: 'Document already exists' },
) {
  override get message() {
    return `Document ${this.documentId} already exists`
  }
}

/** A command on a retired document incarnation. */
export class DocumentRetired extends Schema.TaggedError<DocumentRetired>()(
  'DocumentRetired',
  { documentId: Schema.Int },
  { title: 'Document is retired' },
) {
  override get message() {
    return `Document ${this.documentId} is retired`
  }
}

/** A copy whose source the same batch also changes. */
export class CopySourceChanged extends Schema.TaggedError<CopySourceChanged>()(
  'CopySourceChanged',
  { documentId: Schema.Int },
  { title: 'Document copy source is changed in the copy batch' },
) {
  override get message() {
    return `Document copy ${this.documentId} source is changed in the copy batch`
  }
}

/** Two current incarnations would share one document address. */
export class AddressOccupied extends Schema.TaggedError<AddressOccupied>()(
  'AddressOccupied',
  {},
  { title: 'Document address already has a current incarnation' },
) {
  override get message() {
    return 'Document address already has a current incarnation'
  }
}

/** A delta for a document that has no revision to apply it to. */
export class DeltaWithoutBase extends Schema.TaggedError<DeltaWithoutBase>()(
  'DeltaWithoutBase',
  { documentId: Schema.Int },
  { title: 'Document delta has no base' },
) {
  override get message() {
    return `Document ${this.documentId} delta has no base`
  }
}

/** A delta at another version than the stored one: a version change needs a base. */
export class VersionWithoutBase extends Schema.TaggedError<VersionWithoutBase>()(
  'VersionWithoutBase',
  { documentId: Schema.Int },
  { title: 'Document version transition requires a base' },
) {
  override get message() {
    return `Document ${this.documentId} version transition requires a base`
  }
}

/** A copy's source cannot be read at the requested point. */
export class CopySourceUnreadable extends Schema.TaggedError<CopySourceUnreadable>()(
  'CopySourceUnreadable',
  { documentId: Schema.Int },
  { title: 'Fork source document cannot be read' },
) {
  override get message() {
    return `Fork source document ${this.documentId} cannot be read`
  }
}

/** A copy's source is not the same kind of document as the copy. */
export class CopySourceMismatch extends Schema.TaggedError<CopySourceMismatch>()(
  'CopySourceMismatch',
  { documentId: Schema.Int },
  { title: 'Fork source document does not match the copied record' },
) {
  override get message() {
    return `Fork source document ${this.documentId} does not match the copied record`
  }
}

/** A copy failed for a reason other than an invalid request; the cause is kept. */
export class CopyRejected extends Schema.TaggedError<CopyRejected>()(
  'CopyRejected',
  { documentId: Schema.Int, cause: Schema.Defect() },
  { title: 'Document copy was rejected' },
) {
  override get message() {
    return `Document copy ${this.documentId} was rejected`
  }
}

/**
 * A document's stored revisions cannot be replayed: the base a read needs is missing, or the
 * delta tail crosses a version without a base. This is stored corruption, never a request error.
 */
export class RevisionsCorrupt extends Schema.TaggedError<RevisionsCorrupt>()(
  'RevisionsCorrupt',
  { documentId: Schema.Int, problem: Schema.Literals(['missing base', 'version boundary']) },
  { title: 'Document revisions cannot be replayed' },
) {
  override get message() {
    return this.problem === 'missing base'
      ? `Document ${this.documentId} is missing a required base`
      : `Document ${this.documentId} crosses a stored version boundary without a base`
  }
}
