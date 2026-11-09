CREATE TABLE "vivid_computer_commands" (
	"handle" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"command" text NOT NULL,
	"started_at" bigint NOT NULL,
	"output_at" bigint NOT NULL,
	"output_digest" text,
	"unreachable" jsonb,
	"stopped_at" bigint
);
--> statement-breakpoint
ALTER TABLE "vivid_computer_commands" ADD CONSTRAINT "vivid_computer_commands_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;