import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  index,
  integer,
  pgTable,
  text,
  customType
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const epoch = (name: string) => bigint(name, { mode: "number" });
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector"
});

export const schemaMigrations = pgTable("vivid_schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: epoch("applied_at").notNull()
});

export const conversations = pgTable("vivid_conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  preview: text("preview").notNull().default(""),
  updatedAt: epoch("updated_at").notNull(),
  archived: boolean("archived").notNull().default(false)
}, (table) => [index("vivid_conversations_updated_at").on(table.updatedAt)]);

export const tasks = pgTable("vivid_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  assignee: text("assignee"),
  dueAt: epoch("due_at"),
  originKind: text("origin_kind").notNull(),
  originId: text("origin_id"),
  createdBy: text("created_by").notNull(),
  conversationId: text("conversation_id").notNull(),
  overdueNotifiedAt: epoch("overdue_notified_at"),
  completedAt: epoch("completed_at"),
  createdAt: epoch("created_at").notNull(),
  updatedAt: epoch("updated_at").notNull()
}, (table) => [index("vivid_tasks_status_due").on(table.status, table.dueAt)]);

export const followUps = pgTable("vivid_follow_ups", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  at: epoch("at").notNull(),
  note: text("note").notNull().default(""),
  repeatEveryMs: epoch("repeat_every_ms"),
  status: text("status").notNull().default("scheduled"),
  submissionId: text("submission_id"),
  firedAt: epoch("fired_at"),
  output: text("output"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: epoch("created_at").notNull()
}, (table) => [index("vivid_follow_ups_status_at").on(table.status, table.at)]);

export const notifications = pgTable("vivid_notifications", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  taskId: text("task_id"),
  conversationId: text("conversation_id"),
  createdAt: epoch("created_at").notNull(),
  readAt: epoch("read_at")
}, (table) => [index("vivid_notifications_created").on(table.createdAt)]);

export const routines = pgTable("vivid_routines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull(),
  libraryFolderId: text("library_folder_id"),
  enabled: boolean("enabled").notNull().default(true),
  nextExpectedAt: epoch("next_expected_at"),
  lastMissedAt: epoch("last_missed_at"),
  createdAt: epoch("created_at").notNull(),
  updatedAt: epoch("updated_at").notNull()
});

export const routineRuns = pgTable("vivid_routine_runs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  submissionId: text("submission_id"),
  status: text("status").notNull(),
  startedAt: epoch("started_at").notNull(),
  finishedAt: epoch("finished_at"),
  output: text("output"),
  error: text("error")
}, (table) => [index("vivid_routine_runs_routine_started").on(table.routineId, table.startedAt)]);

export const libraryFolders = pgTable("vivid_library_folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id").references((): AnyPgColumn => libraryFolders.id, { onDelete: "cascade" }),
  createdAt: epoch("created_at").notNull(),
  updatedAt: epoch("updated_at").notNull()
});

export const libraryDocuments = pgTable("vivid_library_documents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: epoch("size").notNull(),
  sha256: text("sha256").notNull().unique(),
  status: text("status").notNull(),
  bytes: bytea("bytes").notNull(),
  extractedText: text("extracted_text").notNull().default(""),
  error: text("error"),
  createdAt: epoch("created_at").notNull(),
  updatedAt: epoch("updated_at").notNull(),
  folderId: text("folder_id")
}, (table) => [index("vivid_library_documents_folder").on(table.folderId, table.createdAt)]);

const chunkText = text("text").notNull();
export const libraryChunks = pgTable("vivid_library_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => libraryDocuments.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  page: integer("page"),
  text: chunkText,
  searchVector: tsvector("search_vector").generatedAlwaysAs(() => sql.raw("to_tsvector('simple', \"text\")"))
}, (table) => [
  index("vivid_library_chunks_document").on(table.documentId, table.ordinal),
  index("vivid_library_chunks_search").using("gin", table.searchVector)
]);

export const runtimeSchema = {
  schemaMigrations,
  conversations,
  tasks,
  followUps,
  notifications,
  routines,
  routineRuns,
  libraryFolders,
  libraryDocuments,
  libraryChunks
};
