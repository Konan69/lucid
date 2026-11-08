ALTER TABLE "vivid_feed_cards" ADD COLUMN "came_from" text;--> statement-breakpoint
ALTER TABLE "vivid_feed_cards" ADD COLUMN "urgency" text DEFAULT 'ordinary' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_feed_cards" ADD COLUMN "told_at" bigint;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD COLUMN "condition" jsonb DEFAULT '{"_tag":"Continuous"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD COLUMN "purpose" jsonb DEFAULT '{"_tag":"Event"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD COLUMN "state_data" jsonb;--> statement-breakpoint
DROP INDEX "vivid_watches_live_name";--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_watches_live_name" ON "vivid_watches" ("person_id","name") WHERE "state" not in ('Stopped', 'Completed');--> statement-breakpoint
CREATE INDEX "vivid_feed_cards_untold" ON "vivid_feed_cards" ("person_id","posted_at") WHERE "urgency" = 'ordinary' and "told_at" is null;--> statement-breakpoint
ALTER TABLE "vivid_watches" DROP CONSTRAINT "vivid_watches_state", ADD CONSTRAINT "vivid_watches_state" CHECK (("state" = 'Pending' and "refresh_before" is null and "stop_reason" is null and "state_data" is null)
        or ("state" = 'Active' and "refresh_before" is not null and "stop_reason" is null and "state_data" is null)
        or ("state" in ('Paused', 'Completed') and "state_data" is not null and "state_data"->>'_tag' = "state" and "stop_reason" is null)
        or ("state" = 'Stopped' and "stop_reason" is not null and "state_data" is null));