CREATE TABLE "vivid_approvals" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"run_id" text,
	"person_id" text NOT NULL,
	"company_id" text,
	"action" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"finished_at" bigint,
	"outcome" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_audit_entries" (
	"id" text PRIMARY KEY,
	"at" bigint NOT NULL,
	"person_id" text NOT NULL,
	"company_id" text,
	"by" text NOT NULL,
	"thread_id" text,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_computers" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"machine" text NOT NULL,
	"status" text NOT NULL,
	"since" bigint NOT NULL,
	"reason" text,
	"held" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_connections" (
	"id" text PRIMARY KEY,
	"service" text NOT NULL,
	"service_name" text NOT NULL,
	"label" text NOT NULL,
	"person_id" text NOT NULL,
	"company_id" text,
	"references" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_input_requests" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"run_id" text,
	"person_id" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"allows_own_answer" boolean NOT NULL,
	"status" text NOT NULL,
	"answered_by" text,
	"answer" text,
	"settled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_rules" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"company_id" text,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_runs" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"person_id" text NOT NULL,
	"origin" jsonb NOT NULL,
	"state" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "vivid_skills" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"company_id" text,
	"name" text NOT NULL,
	"use_when" text NOT NULL,
	"instructions" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_thread_participants" (
	"thread_id" text,
	"person_id" text,
	"added_at" bigint NOT NULL,
	CONSTRAINT "vivid_thread_participants_pkey" PRIMARY KEY("thread_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "vivid_thread_reads" (
	"thread_id" text,
	"person_id" text,
	"read_at" bigint NOT NULL,
	CONSTRAINT "vivid_thread_reads_pkey" PRIMARY KEY("thread_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "vivid_library_documents" DROP CONSTRAINT "vivid_library_documents_sha256_key";--> statement-breakpoint
ALTER TABLE "vivid_library_documents" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_library_documents" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_notifications" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_notifications" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "trigger" text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "webhook_key_hash" text;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD COLUMN "assignee_person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD COLUMN "audience" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "vivid_routines" ALTER COLUMN "cron" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_routines" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "vivid_approvals_thread" ON "vivid_approvals" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "vivid_approvals_person" ON "vivid_approvals" ("person_id","status");--> statement-breakpoint
CREATE INDEX "vivid_approvals_pending" ON "vivid_approvals" ("status","expires_at");--> statement-breakpoint
CREATE INDEX "vivid_audit_entries_person" ON "vivid_audit_entries" ("person_id","at");--> statement-breakpoint
CREATE INDEX "vivid_audit_entries_company" ON "vivid_audit_entries" ("company_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_computers_person" ON "vivid_computers" ("person_id");--> statement-breakpoint
CREATE INDEX "vivid_connections_person" ON "vivid_connections" ("person_id");--> statement-breakpoint
CREATE INDEX "vivid_connections_company" ON "vivid_connections" ("company_id");--> statement-breakpoint
CREATE INDEX "vivid_input_requests_thread" ON "vivid_input_requests" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "vivid_input_requests_person" ON "vivid_input_requests" ("person_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_library_documents_mine" ON "vivid_library_documents" ("person_id","sha256") WHERE "company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_library_documents_company" ON "vivid_library_documents" ("company_id","sha256") WHERE "company_id" is not null;--> statement-breakpoint
CREATE INDEX "vivid_notifications_person" ON "vivid_notifications" ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "vivid_rules_person" ON "vivid_rules" ("person_id");--> statement-breakpoint
CREATE INDEX "vivid_rules_company" ON "vivid_rules" ("company_id");--> statement-breakpoint
CREATE INDEX "vivid_runs_thread" ON "vivid_runs" ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "vivid_runs_state" ON "vivid_runs" ("state");--> statement-breakpoint
CREATE INDEX "vivid_skills_person" ON "vivid_skills" ("person_id");--> statement-breakpoint
CREATE INDEX "vivid_skills_company" ON "vivid_skills" ("company_id");--> statement-breakpoint
CREATE INDEX "vivid_tasks_person" ON "vivid_tasks" ("person_id","status");--> statement-breakpoint
CREATE INDEX "vivid_tasks_company" ON "vivid_tasks" ("company_id","status");--> statement-breakpoint
CREATE INDEX "vivid_tasks_assignee" ON "vivid_tasks" ("assignee_person_id","status");--> statement-breakpoint
CREATE INDEX "vivid_thread_participants_person" ON "vivid_thread_participants" ("person_id");--> statement-breakpoint
CREATE INDEX "vivid_conversations_person" ON "vivid_conversations" ("person_id","updated_at");--> statement-breakpoint
CREATE INDEX "vivid_conversations_company" ON "vivid_conversations" ("company_id","updated_at");--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD CONSTRAINT "vivid_approvals_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD CONSTRAINT "vivid_approvals_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD CONSTRAINT "vivid_approvals_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD CONSTRAINT "vivid_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vivid_audit_entries" ADD CONSTRAINT "vivid_audit_entries_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_audit_entries" ADD CONSTRAINT "vivid_audit_entries_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_computers" ADD CONSTRAINT "vivid_computers_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD CONSTRAINT "vivid_connections_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD CONSTRAINT "vivid_connections_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD CONSTRAINT "vivid_input_requests_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD CONSTRAINT "vivid_input_requests_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD CONSTRAINT "vivid_input_requests_answered_by_user_id_fkey" FOREIGN KEY ("answered_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vivid_library_documents" ADD CONSTRAINT "vivid_library_documents_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_library_documents" ADD CONSTRAINT "vivid_library_documents_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ADD CONSTRAINT "vivid_library_folders_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ADD CONSTRAINT "vivid_library_folders_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_notifications" ADD CONSTRAINT "vivid_notifications_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_notifications" ADD CONSTRAINT "vivid_notifications_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD CONSTRAINT "vivid_routines_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD CONSTRAINT "vivid_routines_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_rules" ADD CONSTRAINT "vivid_rules_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_rules" ADD CONSTRAINT "vivid_rules_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_runs" ADD CONSTRAINT "vivid_runs_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_runs" ADD CONSTRAINT "vivid_runs_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_skills" ADD CONSTRAINT "vivid_skills_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_skills" ADD CONSTRAINT "vivid_skills_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD CONSTRAINT "vivid_tasks_assignee_person_id_user_id_fkey" FOREIGN KEY ("assignee_person_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD CONSTRAINT "vivid_tasks_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ADD CONSTRAINT "vivid_tasks_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_thread_participants" ADD CONSTRAINT "vivid_thread_participants_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_thread_participants" ADD CONSTRAINT "vivid_thread_participants_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_thread_reads" ADD CONSTRAINT "vivid_thread_reads_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_thread_reads" ADD CONSTRAINT "vivid_thread_reads_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD CONSTRAINT "vivid_conversations_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD CONSTRAINT "vivid_conversations_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD CONSTRAINT "vivid_conversations_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;