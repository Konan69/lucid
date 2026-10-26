CREATE TABLE "vivid_message_keys" (
	"run_id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_message_keys" ADD CONSTRAINT "vivid_message_keys_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;