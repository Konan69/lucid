DROP TABLE "vivid_channel_notices";--> statement-breakpoint
ALTER TABLE "vivid_channel_links" ADD COLUMN "since" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_channel_links" DROP COLUMN "state";