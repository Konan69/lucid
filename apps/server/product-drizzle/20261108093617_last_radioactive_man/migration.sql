CREATE TABLE "vivid_computer_recoveries" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"step" text NOT NULL,
	"created_at" bigint NOT NULL,
	"outcome" jsonb
);
--> statement-breakpoint
ALTER TABLE "vivid_computer_recoveries" ADD CONSTRAINT "vivid_computer_recoveries_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;