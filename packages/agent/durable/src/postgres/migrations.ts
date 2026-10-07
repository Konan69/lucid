import { safeNumber, validateSchema } from './database.ts'
import * as Option from 'effect/Option'
import type { PostgresDatabase } from './database.ts'

/** Pi src/storage/sqlite/migrations.ts:SqliteMigration, ordered SQL version. */
export type PostgresMigration = {
  readonly version: number
  readonly statements: readonly string[]
}

/** Pi src/storage/sqlite/migrations.ts:INITIAL_SCHEMA, same columns and indexes.
 * PostgreSQL has no STRICT table suffix; native types enforce it. IS JSON replaces
 * json_valid without decoding escapes or rewriting JSON TEXT. IDs/sequences use
 * BIGINT (including next_id, formerly TEXT); versions also retain SQLite INTEGER’s
 * 64-bit range. Checked flags remain INTEGER.
 * Indexed text uses C collation because SQLite compares encoded identities bytewise.
 * PostgreSQL docs: https://www.postgresql.org/docs/18/functions-json.html
 */
const INITIAL_SCHEMA: readonly string[] = [
  `CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id BIGINT NOT NULL,
		next_seq BIGINT NOT NULL
	)`,
  `INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
  `CREATE TABLE record_ids (
		id BIGINT PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	)`,
  `CREATE TABLE conversations (
		id BIGINT PRIMARY KEY,
		owner_conversation_id BIGINT,
		owner_task_id BIGINT,
		record TEXT NOT NULL CHECK (record IS JSON)
	)`,
  'CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)',
  'CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)',
  `CREATE TABLE entries (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		head BIGINT,
		commit_seq BIGINT NOT NULL,
		record TEXT NOT NULL CHECK (record IS JSON)
	)`,
  'CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)',
  'CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL',
  `CREATE TABLE tasks (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		kind TEXT COLLATE "C" NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (record IS JSON)
	)`,
  'CREATE INDEX tasks_by_status ON tasks (status, id)',
  'CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)',
  'CREATE INDEX tasks_by_kind ON tasks (kind, id)',
  'CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)',
  'CREATE INDEX tasks_by_background ON tasks (background, id)',
  `CREATE TABLE submissions (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		request_id TEXT COLLATE "C",
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (record IS JSON)
	)`,
  'CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)',
  'CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)',
  'CREATE INDEX submissions_by_status ON submissions (status, id)',
  `CREATE TABLE documents (
		id BIGINT PRIMARY KEY,
		kind TEXT COLLATE "C" NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT COLLATE "C" NOT NULL,
		scope_kind TEXT COLLATE "C" NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id BIGINT NOT NULL,
		created_at BIGINT NOT NULL,
		retired_at BIGINT,
		record TEXT NOT NULL CHECK (record IS JSON)
	)`,
  `CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
  'CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)',
  'CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)',
  `CREATE TABLE document_revisions (
		document_id BIGINT NOT NULL,
		seq BIGINT NOT NULL,
		kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('base', 'delta')),
		version BIGINT NOT NULL,
		content TEXT NOT NULL CHECK (content IS JSON),
		PRIMARY KEY (document_id, seq)
	)`,
  'CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)',
]

/** Pi src/storage/sqlite/migrations.ts:SQLITE_MIGRATIONS, immutable ordered history.
 * Append new migrations after the initial schema ships. */
export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  { version: 1, statements: INITIAL_SCHEMA },
]

/** Pi migrations.ts:CURRENT_SQLITE_SCHEMA_VERSION; version 1 always exists here. */
export const CURRENT_POSTGRES_SCHEMA_VERSION = Option.getOrThrow(
  Option.fromNullishOr(POSTGRES_MIGRATIONS.at(-1)),
).version

type SchemaRow = { readonly version: string }

/** Pi src/storage/sqlite/migrations.ts:applySqliteMigrations, contiguous history in one transaction.
 * ON CONFLICT DO NOTHING replaces INSERT OR IGNORE. Namespace creation joins
 * the reference migration transaction; the durable_schema version row is retained. */
export async function applyPostgresMigrations(
  database: PostgresDatabase,
  schema: string,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<void> {
  validateSchema(schema)
  for (let index = 0; index < migrations.length; index++) {
    if (Option.getOrThrow(Option.fromNullishOr(migrations[index])).version !== index + 1) {
      throw new Error('Durable PostgreSQL migrations must have contiguous versions starting at 1')
    }
  }

  await database.transaction(async (transaction) => {
    await transaction.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version BIGINT NOT NULL CHECK (version >= 0)
		)`)
    await transaction.run(
      'INSERT INTO durable_schema (singleton, version) VALUES (1, 0) ON CONFLICT DO NOTHING',
    )
    const row = Option.getOrUndefined(
      await transaction.get<SchemaRow>('SELECT version FROM durable_schema WHERE singleton = 1'),
    )
    if (row === undefined) throw new Error('Durable PostgreSQL schema metadata is missing')
    const storedVersion = safeNumber(row.version)
    const currentVersion =
      migrations.length === 0
        ? 0
        : Option.getOrThrow(Option.fromNullishOr(migrations.at(-1))).version
    if (storedVersion > currentVersion) {
      throw new Error(
        `Durable PostgreSQL schema version ${storedVersion} is newer than supported version ${currentVersion}`,
      )
    }
    for (const migration of migrations) {
      if (migration.version <= storedVersion) continue
      for (const statement of migration.statements) await transaction.exec(statement)
      await transaction.run(
        'UPDATE durable_schema SET version = ? WHERE singleton = 1',
        migration.version,
      )
    }
  })
}
