CREATE TABLE "artifact_files" (
	"artifact_id" text,
	"number" integer,
	"role" text,
	"metadata" jsonb NOT NULL,
	"bytes" bytea NOT NULL,
	CONSTRAINT "artifact_files_pkey" PRIMARY KEY("artifact_id","number","role"),
	CONSTRAINT "artifact_file_size" CHECK (octet_length("bytes") between 1 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "artifact_preparations" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"person_id" text NOT NULL,
	"run_id" text NOT NULL,
	"inspect_call" text NOT NULL,
	"capture" jsonb NOT NULL,
	"output" bytea NOT NULL,
	"source" bytea,
	"preview" bytea,
	"publish_call" text,
	"publication" jsonb,
	CONSTRAINT "artifact_preparation_size" CHECK (octet_length("output") between 1 and 10485760 and ("source" is null or octet_length("source") between 1 and 10485760) and ("preview" is null or octet_length("preview") between 1 and 10485760))
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "file" jsonb;--> statement-breakpoint
ALTER TABLE "artifact_versions" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_inspection_call" ON "artifact_preparations" ("thread_id","run_id","inspect_call");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_publication_call" ON "artifact_preparations" ("thread_id","run_id","publish_call");--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_ji1o3AjaBeKd_fkey" FOREIGN KEY ("artifact_id","number") REFERENCES "artifact_versions"("artifact_id","number") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_preparations" ADD CONSTRAINT "artifact_preparations_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_preparations" ADD CONSTRAINT "artifact_preparations_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_preparations" ADD CONSTRAINT "artifact_preparations_run_id_vivid_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "vivid_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_version_content" CHECK (("body" is null) <> ("file" is null));