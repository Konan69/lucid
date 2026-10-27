CREATE SCHEMA "runtime";
--> statement-breakpoint
CREATE TABLE "runtime"."conversations" (
	"store_id" uuid,
	"id" bigint,
	"owner_conversation_id" bigint,
	"owner_task_id" bigint,
	"record" text NOT NULL,
	CONSTRAINT "conversations_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "conversations_record" CHECK ("record" IS JSON)
);
--> statement-breakpoint
CREATE TABLE "runtime"."document_revisions" (
	"store_id" uuid,
	"document_id" bigint,
	"seq" bigint,
	"kind" text NOT NULL,
	"version" bigint NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "document_revisions_pkey" PRIMARY KEY("store_id","document_id","seq"),
	CONSTRAINT "document_revisions_kind" CHECK ("kind" IN ('base', 'delta')),
	CONSTRAINT "document_revisions_content" CHECK ("content" IS JSON)
);
--> statement-breakpoint
CREATE TABLE "runtime"."documents" (
	"store_id" uuid,
	"id" bigint,
	"kind" text NOT NULL,
	"family" integer NOT NULL,
	"key_value" text NOT NULL,
	"scope_kind" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"retired_at" bigint,
	"record" text NOT NULL,
	CONSTRAINT "documents_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "documents_family" CHECK ("family" IN (0, 1)),
	CONSTRAINT "documents_scope_kind" CHECK ("scope_kind" IN ('session', 'conversation', 'task')),
	CONSTRAINT "documents_record" CHECK ("record" IS JSON)
);
--> statement-breakpoint
CREATE TABLE "runtime"."entries" (
	"store_id" uuid,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"head" bigint,
	"commit_seq" bigint NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "entries_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "entries_record" CHECK ("record" IS JSON)
);
--> statement-breakpoint
CREATE TABLE "runtime"."metadata" (
	"store_id" uuid PRIMARY KEY,
	"next_id" bigint NOT NULL,
	"next_seq" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime"."owner" (
	"id" smallint PRIMARY KEY,
	"generation" bigint NOT NULL,
	"process" text NOT NULL,
	CONSTRAINT "owner_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "runtime"."record_ids" (
	"store_id" uuid,
	"id" bigint,
	"record_type" text NOT NULL,
	CONSTRAINT "record_ids_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "record_ids_type" CHECK ("record_type" IN ('conversation', 'entry', 'task', 'submission', 'document'))
);
--> statement-breakpoint
CREATE TABLE "runtime"."stores" (
	"id" uuid PRIMARY KEY,
	"person_id" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "runtime"."submissions" (
	"store_id" uuid,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"request_id" text,
	"status" text NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "submissions_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "submissions_status" CHECK ("status" IN ('queued', 'placed', 'done', 'unanswered')),
	CONSTRAINT "submissions_record" CHECK ("record" IS JSON)
);
--> statement-breakpoint
CREATE TABLE "runtime"."tasks" (
	"store_id" uuid,
	"id" bigint,
	"conversation_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"abort_requested" integer NOT NULL,
	"background" integer NOT NULL,
	"record" text NOT NULL,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("store_id","id"),
	CONSTRAINT "tasks_status" CHECK ("status" IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
	CONSTRAINT "tasks_abort_requested" CHECK ("abort_requested" IN (0, 1)),
	CONSTRAINT "tasks_background" CHECK ("background" IN (0, 1)),
	CONSTRAINT "tasks_record" CHECK ("record" IS JSON)
);
--> statement-breakpoint
CREATE INDEX "conversations_by_owner_conversation" ON "runtime"."conversations" ("store_id","owner_conversation_id","id");--> statement-breakpoint
CREATE INDEX "conversations_by_owner_task" ON "runtime"."conversations" ("store_id","owner_task_id","id");--> statement-breakpoint
CREATE INDEX "document_revisions_by_kind" ON "runtime"."document_revisions" ("store_id","document_id","kind","seq" DESC);--> statement-breakpoint
CREATE INDEX "documents_by_address" ON "runtime"."documents" ("store_id","kind","scope_kind","owner_id","family","key_value","created_at" DESC,"retired_at");--> statement-breakpoint
CREATE INDEX "documents_by_scope" ON "runtime"."documents" ("store_id","scope_kind","owner_id","id");--> statement-breakpoint
CREATE INDEX "documents_by_scope_kind" ON "runtime"."documents" ("store_id","scope_kind","owner_id","kind","id");--> statement-breakpoint
CREATE INDEX "entries_by_conversation" ON "runtime"."entries" ("store_id","conversation_id","id" DESC);--> statement-breakpoint
CREATE INDEX "entry_heads_by_conversation" ON "runtime"."entries" ("store_id","conversation_id","id" DESC) WHERE "head" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "submissions_by_request" ON "runtime"."submissions" ("store_id","conversation_id","request_id");--> statement-breakpoint
CREATE INDEX "submissions_by_conversation" ON "runtime"."submissions" ("store_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "submissions_by_status" ON "runtime"."submissions" ("store_id","status","id");--> statement-breakpoint
CREATE INDEX "submissions_queued" ON "runtime"."submissions" ("store_id") WHERE "status" = 'queued';--> statement-breakpoint
CREATE INDEX "tasks_by_status" ON "runtime"."tasks" ("store_id","status","id");--> statement-breakpoint
CREATE INDEX "tasks_by_conversation" ON "runtime"."tasks" ("store_id","conversation_id","id");--> statement-breakpoint
CREATE INDEX "tasks_by_kind" ON "runtime"."tasks" ("store_id","kind","id");--> statement-breakpoint
CREATE INDEX "tasks_by_abort_requested" ON "runtime"."tasks" ("store_id","abort_requested","id");--> statement-breakpoint
CREATE INDEX "tasks_by_background" ON "runtime"."tasks" ("store_id","background","id");--> statement-breakpoint
CREATE INDEX "tasks_live" ON "runtime"."tasks" ("store_id") WHERE "status" <> 'terminal';--> statement-breakpoint
ALTER TABLE "runtime"."metadata" ADD CONSTRAINT "metadata_store_id_stores_id_fkey" FOREIGN KEY ("store_id") REFERENCES "runtime"."stores"("id");