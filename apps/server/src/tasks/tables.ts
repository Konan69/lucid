import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'
import { companyColumn, epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * `person_id` is the Person a Task belongs to: who made it, or on whose behalf Vivid made it
 * (`created_by` says which). `assignee_person_id` names a Member who owes the work; `assignee` is
 * the free-text name of someone outside Vivid. At most one of the two is set, and neither means
 * nobody is assigned. `conversation_id` is the Thread the Task reports back to.
 */
export const tasks = pgTable(
  'vivid_tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    assignee: text('assignee'),
    assigneePersonId: text('assignee_person_id').references(() => personTable.id, {
      onDelete: 'set null',
    }),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    dueAt: epoch('due_at'),
    originKind: text('origin_kind').notNull(),
    originId: text('origin_id'),
    createdBy: text('created_by').notNull(),
    // A Task reports to a Thread and is found through it, so it goes when the Thread goes:
    // otherwise its follow-ups would keep firing at a Thread nobody can open.
    conversationId: threadColumn('conversation_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    overdueNotifiedAt: epoch('overdue_notified_at'),
    completedAt: epoch('completed_at'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    index('vivid_tasks_status_due').on(table.status, table.dueAt),
    index('vivid_tasks_person').on(table.personId, table.status),
    index('vivid_tasks_company').on(table.companyId, table.status),
    index('vivid_tasks_assignee').on(table.assigneePersonId, table.status),
  ],
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
    /** The Person this notification is for, and the workspace it happened in. */
    personId: personColumn().notNull(),
    companyId: companyColumn(),
  },
  (table) => [
    index('vivid_notifications_created').on(table.createdAt),
    index('vivid_notifications_person').on(table.personId, table.createdAt),
  ],
)
