CREATE TABLE "vivid_todos" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"company_id" text,
	"thread_id" text NOT NULL,
	"what" text NOT NULL,
	"due" bigint,
	"state" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_todos_owner" ON "vivid_todos" ("person_id","company_id");--> statement-breakpoint
ALTER TABLE "vivid_todos" ADD CONSTRAINT "vivid_todos_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_todos" ADD CONSTRAINT "vivid_todos_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_todos" ADD CONSTRAINT "vivid_todos_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;