CREATE TABLE "vivid_memory_forgets" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"origin" text NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_memory_forgets_thread" ON "vivid_memory_forgets" ("person_id","thread_id","created_at");--> statement-breakpoint
ALTER TABLE "vivid_memory_forgets" ADD CONSTRAINT "vivid_memory_forgets_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_memory_forgets" ADD CONSTRAINT "vivid_memory_forgets_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;