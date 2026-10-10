ALTER TABLE "vivid_input_requests" DROP COLUMN "question";--> statement-breakpoint
ALTER TABLE "vivid_input_requests" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "vivid_input_requests" DROP COLUMN "allows_own_answer";--> statement-breakpoint
ALTER TABLE "vivid_input_requests" DROP COLUMN "answer";--> statement-breakpoint
ALTER TABLE "vivid_input_requests" ALTER COLUMN "questions" SET NOT NULL;