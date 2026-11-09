CREATE TABLE "vivid_handoffs" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"person_id" text NOT NULL,
	"summary" text NOT NULL,
	"request" jsonb NOT NULL,
	"page" jsonb NOT NULL,
	"binding" jsonb NOT NULL,
	"status" text NOT NULL,
	"receipts" jsonb,
	"completed_by" text,
	"settled_at" bigint,
	"signal" jsonb DEFAULT '{"_tag":"None"}' NOT NULL,
	"signal_due_at" bigint DEFAULT 0 NOT NULL,
	"signal_claim" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_handoffs_signal" ON "vivid_handoffs" ("signal_due_at") WHERE "signal"->>'_tag' = 'Owed';--> statement-breakpoint
CREATE INDEX "vivid_handoffs_thread" ON "vivid_handoffs" ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_handoffs_open" ON "vivid_handoffs" ("person_id") WHERE "status" in ('waiting', 'applying', 'ready', 'completing', 'withdrawing', 'draining');--> statement-breakpoint
ALTER TABLE "vivid_handoffs" ADD CONSTRAINT "vivid_handoffs_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_handoffs" ADD CONSTRAINT "vivid_handoffs_run_id_vivid_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "vivid_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_handoffs" ADD CONSTRAINT "vivid_handoffs_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_handoffs" ADD CONSTRAINT "vivid_handoffs_completed_by_user_id_fkey" FOREIGN KEY ("completed_by") REFERENCES "user"("id") ON DELETE SET NULL;