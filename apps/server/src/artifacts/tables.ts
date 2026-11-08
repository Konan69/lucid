import { sql } from 'drizzle-orm'
import {
  bytea,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type {
  ArtifactId,
  ArtifactKind,
  ArtifactInspectionId,
  ArtifactFileRole,
  DocumentToolCallId,
  RunId,
} from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { runs, threads } from '../threads/tables.ts'

/** Thread ownership cascades through every immutable version; names are unique ignoring case. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').$type<ArtifactId>().primaryKey(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    title: text('title').notNull(),
    version: integer('version').notNull(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [uniqueIndex('artifacts_thread_title').on(table.threadId, sql`lower(${table.title})`)],
)

/** Bodies and encoded author snapshots are append-only; a removed Person does not erase attribution. */
export const artifactVersions = pgTable(
  'artifact_versions',
  {
    artifactId: text('artifact_id')
      .$type<ArtifactId>()
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    body: text('body'),
    file: jsonb('file'),
    note: text('note'),
    madeBy: jsonb('made_by').notNull(),
    at: epoch('at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.number] }),
    check('artifact_version_content', sql`(${table.body} is null) <> (${table.file} is null)`),
  ],
)

/** The version FK makes removal atomic while bytes remain immutable for surviving versions. */
export const artifactFiles = pgTable(
  'artifact_files',
  {
    artifactId: text('artifact_id').$type<ArtifactId>().notNull(),
    number: integer('number').notNull(),
    role: text('role').$type<ArtifactFileRole>().notNull(),
    metadata: jsonb('metadata').notNull(),
    bytes: bytea('bytes').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.number, table.role] }),
    foreignKey({
      columns: [table.artifactId, table.number],
      foreignColumns: [artifactVersions.artifactId, artifactVersions.number],
    }).onDelete('cascade'),
    check('artifact_file_size', sql`octet_length(${table.bytes}) between 1 and 10485760`),
  ],
)

/** Preparations are invisible captures. A persisted publication receipt survives uncertain RPC delivery. */
export const artifactPreparations = pgTable(
  'artifact_preparations',
  {
    id: text('id').$type<ArtifactInspectionId>().primaryKey(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: personColumn().notNull(),
    runId: text('run_id')
      .$type<RunId>()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    inspectCall: text('inspect_call').$type<DocumentToolCallId>().notNull(),
    capture: jsonb('capture').notNull(),
    output: bytea('output').notNull(),
    source: bytea('source'),
    preview: bytea('preview'),
    publishCall: text('publish_call').$type<DocumentToolCallId>(),
    publication: jsonb('publication'),
  },
  (table) => [
    uniqueIndex('artifact_inspection_call').on(table.threadId, table.runId, table.inspectCall),
    uniqueIndex('artifact_publication_call').on(table.threadId, table.runId, table.publishCall),
    check(
      'artifact_preparation_size',
      sql`octet_length(${table.output}) between 1 and 10485760 and (${table.source} is null or octet_length(${table.source}) between 1 and 10485760) and (${table.preview} is null or octet_length(${table.preview}) between 1 and 10485760)`,
    ),
  ],
)
