DROP TABLE "vivid_watch_arrivals";--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD COLUMN "connection_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_watches" DROP COLUMN "account";--> statement-breakpoint
ALTER TABLE "vivid_watches" DROP COLUMN "subscription";--> statement-breakpoint
CREATE INDEX "vivid_watches_connection" ON "vivid_watches" ("connection_id");--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD CONSTRAINT "vivid_watches_connection_id_vivid_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "vivid_connections"("id") ON DELETE CASCADE;