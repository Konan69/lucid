import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * A Routine is one Person's commitment: `person_id` is who Vivid acts for each time it runs, in the
 * workspace `company_id` names. `trigger` is `schedule` (then `cron` and `timezone` are set) or
 * `webhook` (then `webhook_key_hash` holds the SHA-256 of the key that may call it; the key itself
 * is shown once and never stored). An Integration keeps a typed private Watch/cursor in JSONB;
 * revision checks arbitrate competing observations and pause intent retains one delivery key.
 */
export const routines = pgTable('vivid_routines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  trigger: text('trigger').notNull().default('schedule'),
  cron: text('cron'),
  onceAt: epoch('once_at'),
  timezone: text('timezone'),
  webhookKeyHash: text('webhook_key_hash'),
  integration: jsonb('integration'),
  watchRevision: integer('watch_revision').notNull().default(0),
  eventCounter: integer('event_counter').notNull().default(0),
  pause: jsonb('pause'),
  personId: personColumn().notNull(),
  companyId: companyColumn(),
  libraryFolderId: text('library_folder_id'),
  enabled: boolean('enabled').notNull().default(true),
  nextExpectedAt: epoch('next_expected_at'),
  lastMissedAt: epoch('last_missed_at'),
  createdAt: epoch('created_at').notNull(),
  updatedAt: epoch('updated_at').notNull(),
})

export const occurrences = pgTable(
  'vivid_routine_runs',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull(),
    submissionId: text('submission_id'),
    status: text('status').notNull(),
    startedAt: epoch('started_at').notNull(),
    finishedAt: epoch('finished_at'),
    output: text('output'),
    error: text('error'),
    providerEvent: jsonb('provider_event'),
    eventOrder: integer('event_order'),
  },
  (table) => [index('vivid_routine_runs_routine_started').on(table.routineId, table.startedAt)],
)
