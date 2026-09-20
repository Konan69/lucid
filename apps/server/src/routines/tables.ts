import { bigint, boolean, index, pgTable, text } from 'drizzle-orm/pg-core'

const epoch = (name: string) => bigint(name, { mode: 'number' })

export const routines = pgTable('vivid_routines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
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
  },
  (table) => [index('vivid_routine_runs_routine_started').on(table.routineId, table.startedAt)],
)
