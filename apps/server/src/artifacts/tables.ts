import { sql } from 'drizzle-orm'
import { integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { ArtifactId, ArtifactKind } from '@vivid/contracts'
import { epoch, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

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
    body: text('body').notNull(),
    note: text('note'),
    madeBy: jsonb('made_by').notNull(),
    at: epoch('at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.number] })],
)
