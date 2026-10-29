CREATE TABLE "vivid_child_runs" (
	"id" text PRIMARY KEY,
	"parent_run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_tool_call_id" text NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"brief" text NOT NULL,
	"budget" jsonb NOT NULL,
	"requested_at" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"receipt" jsonb,
	"wake" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_child_runs_call" ON "vivid_child_runs" ("parent_run_id","parent_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_child_runs_number" ON "vivid_child_runs" ("thread_id","number");--> statement-breakpoint
CREATE INDEX "vivid_child_runs_wake" ON "vivid_child_runs" ("wake");--> statement-breakpoint
ALTER TABLE "vivid_child_runs" ADD CONSTRAINT "vivid_child_runs_parent_run_id_vivid_runs_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "vivid_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_child_runs" ADD CONSTRAINT "vivid_child_runs_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;