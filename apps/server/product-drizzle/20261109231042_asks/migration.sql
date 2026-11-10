ALTER TABLE "vivid_approvals" ADD COLUMN "integration_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD COLUMN "integration" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ADD COLUMN "integration_outcome" jsonb;