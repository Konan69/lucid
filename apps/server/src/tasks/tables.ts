import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core'

const epoch = (name: string) => bigint(name, { mode: 'number' })

export const tasks = pgTable(
  'vivid_tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    assignee: text('assignee'),
    dueAt: epoch('due_at'),
    originKind: text('origin_kind').notNull(),
    originId: text('origin_id'),
    createdBy: text('created_by').notNull(),
    conversationId: text('conversation_id').notNull(),
    overdueNotifiedAt: epoch('overdue_notified_at'),
    completedAt: epoch('completed_at'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [index('vivid_tasks_status_due').on(table.status, table.dueAt)],
)

export const followUps = pgTable(
  'vivid_follow_ups',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    at: epoch('at').notNull(),
    note: text('note').notNull().default(''),
    repeatEveryMs: epoch('repeat_every_ms'),
    status: text('status').notNull().default('scheduled'),
    submissionId: text('submission_id'),
    firedAt: epoch('fired_at'),
    output: text('output'),
    error: text('error'),
    createdBy: text('created_by').notNull(),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [index('vivid_follow_ups_status_at').on(table.status, table.at)],
)

export const notifications = pgTable(
  'vivid_notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    taskId: text('task_id'),
    conversationId: text('conversation_id'),
    createdAt: epoch('created_at').notNull(),
    readAt: epoch('read_at'),
  },
  (table) => [index('vivid_notifications_created').on(table.createdAt)],
)
