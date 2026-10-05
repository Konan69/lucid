import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { DraftPlace } from '@vivid/contracts'
import { companyColumn, epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/** One durable order for all of a Person's drafts, including clears and workspace changes. */
export const draftGenerations = pgTable('vivid_draft_generations', {
  personId: personColumn().primaryKey(),
  generation: bigint('generation', { mode: 'number' }).notNull(),
})

/**
 * Unsent words are always Person-owned. company_id is workspace scope, never shared ownership.
 * The generated key distinguishes personal and Company NewThread places without storing a fake
 * workspace id. A single unique index also makes InThread saves atomic across selected workspaces.
 * Drizzle's insert conflict target accepts columns, so a generated column keeps the upsert typed.
 */
export const drafts = pgTable(
  'vivid_drafts',
  {
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    place: text('place').$type<DraftPlace['_tag']>().notNull(),
    threadId: threadColumn('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    placeKey: text('place_key').generatedAlwaysAs(sql`case
      when "place" = 'InThread' then 'InThread:' || "thread_id"
      when "company_id" is null then 'NewThread:Personal'
      else 'NewThread:Company:' || "company_id" end`),
    text: text('text').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    savedAt: epoch('saved_at').notNull(),
    device: text('device').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_drafts_person_place').on(table.personId, table.placeKey),
    index('vivid_drafts_workspace_revision').on(table.personId, table.companyId, table.revision),
    check(
      'vivid_drafts_place_thread',
      sql`(${table.place} = 'NewThread' and ${table.threadId} is null) or (${table.place} = 'InThread' and ${table.threadId} is not null)`,
    ),
  ],
)
