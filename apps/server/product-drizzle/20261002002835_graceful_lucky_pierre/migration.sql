ALTER TABLE "vivid_runs" ADD COLUMN "turn" integer;--> statement-breakpoint
ALTER TABLE "vivid_runs" ADD COLUMN "library_folder" text;--> statement-breakpoint
-- Backfill only product attribution: tied timestamps use the durable submission id for ordering.
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "thread_id" ORDER BY "started_at", "id") AS position
  FROM "vivid_runs"
)
UPDATE "vivid_runs" SET "turn" = ordered.position FROM ordered WHERE "vivid_runs"."id" = ordered."id";
