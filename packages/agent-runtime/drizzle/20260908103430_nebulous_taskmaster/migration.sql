CREATE TABLE "vivid_conversations" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_follow_ups" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"at" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"repeat_every_ms" bigint,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"submission_id" text,
	"fired_at" bigint,
	"output" text,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_library_chunks" (
	"id" text PRIMARY KEY,
	"document_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED
);
--> statement-breakpoint
CREATE TABLE "vivid_library_documents" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL UNIQUE,
	"status" text NOT NULL,
	"bytes" bytea NOT NULL,
	"extracted_text" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"folder_id" text
);
--> statement-breakpoint
CREATE TABLE "vivid_library_folders" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"parent_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_notifications" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"task_id" text,
	"conversation_id" text,
	"created_at" bigint NOT NULL,
	"read_at" bigint
);
--> statement-breakpoint
CREATE TABLE "vivid_routine_runs" (
	"id" text PRIMARY KEY,
	"routine_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"submission_id" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"output" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "vivid_routines" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"library_folder_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_expected_at" bigint,
	"last_missed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_schema_migrations" (
	"version" integer PRIMARY KEY,
	"applied_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_tasks" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee" text,
	"due_at" bigint,
	"origin_kind" text NOT NULL,
	"origin_id" text,
	"created_by" text NOT NULL,
	"conversation_id" text NOT NULL,
	"overdue_notified_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_conversations_updated_at" ON "vivid_conversations" ("updated_at");--> statement-breakpoint
CREATE INDEX "vivid_follow_ups_status_at" ON "vivid_follow_ups" ("status","at");--> statement-breakpoint
CREATE INDEX "vivid_library_chunks_document" ON "vivid_library_chunks" ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "vivid_library_chunks_search" ON "vivid_library_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "vivid_library_documents_folder" ON "vivid_library_documents" ("folder_id","created_at");--> statement-breakpoint
CREATE INDEX "vivid_notifications_created" ON "vivid_notifications" ("created_at");--> statement-breakpoint
CREATE INDEX "vivid_routine_runs_routine_started" ON "vivid_routine_runs" ("routine_id","started_at");--> statement-breakpoint
CREATE INDEX "vivid_tasks_status_due" ON "vivid_tasks" ("status","due_at");--> statement-breakpoint
ALTER TABLE "vivid_follow_ups" ADD CONSTRAINT "vivid_follow_ups_task_id_vivid_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "vivid_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_library_chunks" ADD CONSTRAINT "vivid_library_chunks_lTJBbfSt8ZfB_fkey" FOREIGN KEY ("document_id") REFERENCES "vivid_library_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ADD CONSTRAINT "vivid_library_folders_parent_id_vivid_library_folders_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "vivid_library_folders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_routine_runs" ADD CONSTRAINT "vivid_routine_runs_routine_id_vivid_routines_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "vivid_routines"("id") ON DELETE CASCADE;