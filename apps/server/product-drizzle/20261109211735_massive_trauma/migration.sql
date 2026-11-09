CREATE TABLE "vivid_activity_targets" (
	"installation" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"session_id" text NOT NULL,
	"start_token" text,
	"update_token" text,
	"start_key" text
);
--> statement-breakpoint
ALTER TABLE "vivid_notifications" ADD COLUMN "preview_url" text;--> statement-breakpoint
CREATE INDEX "vivid_activity_targets_person" ON "vivid_activity_targets" ("person_id");--> statement-breakpoint
ALTER TABLE "vivid_activity_targets" ADD CONSTRAINT "vivid_activity_targets_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_activity_targets" ADD CONSTRAINT "vivid_activity_targets_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;