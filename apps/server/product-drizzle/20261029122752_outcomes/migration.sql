CREATE TABLE "vivid_actions" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"run_id" text,
	"approval_id" text,
	"target" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"retry_of" text,
	"claimed_at" bigint NOT NULL,
	"receipt" jsonb,
	"reconciliation" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_runs" ADD COLUMN "response_id" text;--> statement-breakpoint
ALTER TABLE "vivid_runs" ADD COLUMN "delivered_at" bigint;--> statement-breakpoint
CREATE INDEX "vivid_actions_fingerprint" ON "vivid_actions" ("thread_id","fingerprint");--> statement-breakpoint
CREATE INDEX "vivid_actions_run" ON "vivid_actions" ("run_id");--> statement-breakpoint
ALTER TABLE "vivid_actions" ADD CONSTRAINT "vivid_actions_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;