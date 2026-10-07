import * as Schema from 'effect/Schema'

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
  { recordKind: Schema.String },
  { title: 'RawNul' },
) {
  override get message() {
    return `Durable PostgreSQL ${this.recordKind} value contains a raw NUL character`
  }
}
