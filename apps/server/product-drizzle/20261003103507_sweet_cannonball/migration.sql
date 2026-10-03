CREATE TABLE "artifact_versions" (
	"artifact_id" text,
	"number" integer,
	"body" text NOT NULL,
	"note" text,
	"made_by" jsonb NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "artifact_versions_pkey" PRIMARY KEY("artifact_id","number")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_thread_title" ON "artifacts" ("thread_id",lower("title"));--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;