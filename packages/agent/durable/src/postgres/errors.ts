import * as Schema from 'effect/Schema'

/** Pi src/types.ts:StorageWrite record kinds, with metadata for allocation SQL.
 * This closed schema owns both the failure vocabulary and the facade's type. */
export const RecordKind = Schema.Literals([
  'conversation',
  'entry',
  'task',
  'submission',
  'document',
  'metadata',
])

/** Pi src/storage/sqlite/node.ts:openNodeSqliteDatabase has no connection
 * encoding. PostgreSQL literal batches require UTF8 so a multibyte encoding
 * cannot consume an escaping backslash. Refuse the host setting, never change it. */
export class ConnectionSettingInvalid extends Schema.TaggedError<ConnectionSettingInvalid>()(
  'ConnectionSettingInvalid',
  {
    setting: Schema.Literals(['client_encoding', 'standard_conforming_strings']),
    value: Schema.String,
  },
  { title: 'ConnectionSettingInvalid' },
) {
  override get message() {
    return `Durable PostgreSQL refuses connection setting ${this.setting}=${this.value}`
  }
}

/** Pi SqliteStorage stores JSON text, where NUL is escaped. PostgreSQL's wire
 * SQL cannot contain raw NUL; reject it before interpolation can truncate a
 * statement. Escaped JSON NUL and zero bytes in BYTEA remain valid. */
export class RawNul extends Schema.TaggedError<RawNul>()(
  'RawNul',
  { recordKind: RecordKind },
  { title: 'RawNul' },
) {
  override get message() {
    return `Durable PostgreSQL ${this.recordKind} value contains a raw NUL character`
  }
}

/** Pi README.md:Storage requires one owner. PostgreSQL enforces this at open,
 * before migrations, because separate Harness states must never interleave on
 * one schema even when their individual commits do not overlap. */
export class StorageOwned extends Schema.TaggedError<StorageOwned>()(
  'StorageOwned',
  { schema: Schema.String },
  { title: 'StorageOwned' },
) {
  override get message() {
    return `Durable PostgreSQL schema ${this.schema} is already owned by another connection`
  }
}

/** Pi's SQLite connection does not reconnect. A lost PostgreSQL lease also loses
 * its ownership lock: fence the entire storage, including volatile minting, with
 * one diagnostic that tells a host to close/reopen storage and its Harness. */
export class StorageDisconnected extends Schema.TaggedError<StorageDisconnected>()(
  'StorageDisconnected',
  { schema: Schema.String, cause: Schema.Defect() },
  { title: 'StorageDisconnected' },
) {
  override get message() {
    return `Durable PostgreSQL schema ${this.schema} is disconnected; close it, then reopen the storage and the Harness`
  }
}
