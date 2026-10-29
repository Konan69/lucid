CREATE TABLE "vivid_owed" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"company_id" text,
	"thread_id" text NOT NULL,
	"what" text NOT NULL,
	"from" text NOT NULL,
	"since" bigint NOT NULL,
	"due" bigint,
	"blocked_on" text,
	"next_step" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_owed_owner" ON "vivid_owed" ("person_id","company_id");--> statement-breakpoint
ALTER TABLE "vivid_owed" ADD CONSTRAINT "vivid_owed_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_owed" ADD CONSTRAINT "vivid_owed_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_owed" ADD CONSTRAINT "vivid_owed_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;