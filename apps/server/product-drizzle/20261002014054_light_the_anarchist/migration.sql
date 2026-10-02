ALTER TABLE "vivid_approvals" DROP CONSTRAINT "vivid_approvals_thread_id_vivid_conversations_id_fkey";--> statement-breakpoint
ALTER TABLE "vivid_input_requests" DROP CONSTRAINT "vivid_input_requests_thread_id_vivid_conversations_id_fkey";--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD COLUMN "signal" jsonb DEFAULT '{"_tag":"None"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD COLUMN "signal_due_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD COLUMN "signal_claim" text;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD COLUMN "signal" jsonb DEFAULT '{"_tag":"None"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD COLUMN "signal_due_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD COLUMN "signal_claim" text;--> statement-breakpoint
CREATE INDEX "vivid_approvals_signal" ON "vivid_approvals" ("signal_due_at");--> statement-breakpoint
CREATE INDEX "vivid_input_requests_signal" ON "vivid_input_requests" ("signal_due_at");