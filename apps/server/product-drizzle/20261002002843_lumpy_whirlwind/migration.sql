ALTER TABLE "vivid_runs" ALTER COLUMN "turn" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_runs_thread_turn" ON "vivid_runs" ("thread_id","turn");