CREATE TABLE "vivid_feed_cards" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"words" text NOT NULL,
	"display" text,
	"actions" jsonb NOT NULL,
	"state" text NOT NULL,
	"posted_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vivid_watch_arrivals" (
	"watch_id" text,
	"event_id" text,
	"thread_id" text NOT NULL,
	"received_at" bigint NOT NULL,
	"run_id" text,
	CONSTRAINT "vivid_watch_arrivals_pkey" PRIMARY KEY("watch_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "vivid_watches" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"company_id" text,
	"name" text NOT NULL,
	"account" text NOT NULL,
	"event" text NOT NULL,
	"subscribed_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"instruction" text NOT NULL,
	"callback_url" text NOT NULL,
	"state" text NOT NULL,
	"refresh_before" bigint,
	"stop_reason" text,
	"subscription" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "vivid_watches_state" CHECK (("state" = 'Pending' and "refresh_before" is null and "stop_reason" is null)
        or ("state" = 'Active' and "refresh_before" is not null and "stop_reason" is null)
        or ("state" = 'Stopped' and "stop_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "vivid_conversations" ADD COLUMN "place" text DEFAULT 'Conversation' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_feed_cards_thread" ON "vivid_feed_cards" ("thread_id");--> statement-breakpoint
CREATE INDEX "vivid_feed_cards_person" ON "vivid_feed_cards" ("person_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_watches_live_name" ON "vivid_watches" ("person_id","name") WHERE "state" <> 'Stopped';--> statement-breakpoint
CREATE INDEX "vivid_watches_renewal" ON "vivid_watches" ("state","refresh_before");--> statement-breakpoint
ALTER TABLE "vivid_feed_cards" ADD CONSTRAINT "vivid_feed_cards_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_feed_cards" ADD CONSTRAINT "vivid_feed_cards_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_watch_arrivals" ADD CONSTRAINT "vivid_watch_arrivals_watch_id_vivid_watches_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "vivid_watches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_watch_arrivals" ADD CONSTRAINT "vivid_watch_arrivals_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD CONSTRAINT "vivid_watches_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_watches" ADD CONSTRAINT "vivid_watches_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;