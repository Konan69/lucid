ALTER TABLE "vivid_watches" ADD COLUMN "condition" jsonb DEFAULT '{"_tag":"Continuous"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD COLUMN "state_data" jsonb;--> statement-breakpoint
DROP INDEX "vivid_watches_live_name";--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_watches_live_name" ON "vivid_watches" ("person_id","name") WHERE "state" not in ('Stopped', 'Completed');--> statement-breakpoint
ALTER TABLE "vivid_watches" DROP CONSTRAINT "vivid_watches_state", ADD CONSTRAINT "vivid_watches_state" CHECK (("state" = 'Pending' and "refresh_before" is null and "stop_reason" is null and "state_data" is null)
        or ("state" = 'Active' and "refresh_before" is not null and "stop_reason" is null and "state_data" is null)
        or ("state" in ('Paused', 'Completed') and "state_data" is not null and "state_data"->>'_tag' = "state" and "stop_reason" is null)
        or ("state" = 'Stopped' and "stop_reason" is not null and "state_data" is null));