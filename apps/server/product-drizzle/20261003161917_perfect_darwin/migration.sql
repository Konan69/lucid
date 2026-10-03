CREATE TABLE "vivid_device_requests" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"session_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"thread_id" text,
	"request" jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" text NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD CONSTRAINT "vivid_device_requests_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;