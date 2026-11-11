CREATE TABLE "vivid_feed_dismissals" (
	"thread_id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"dismissed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_feed_dismissals_person" ON "vivid_feed_dismissals" ("person_id");--> statement-breakpoint
ALTER TABLE "vivid_feed_dismissals" ADD CONSTRAINT "vivid_feed_dismissals_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_feed_dismissals" ADD CONSTRAINT "vivid_feed_dismissals_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;