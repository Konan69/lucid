CREATE TABLE "vivid_first_threads" (
	"person_id" text PRIMARY KEY,
	"thread_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_first_threads" ADD CONSTRAINT "vivid_first_threads_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;