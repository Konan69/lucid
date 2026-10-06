CREATE TABLE "vivid_drafts" (
	"person_id" text NOT NULL,
	"company_id" text,
	"place" text NOT NULL,
	"thread_id" text,
	"place_key" text GENERATED ALWAYS AS (case
      when "place" = 'InThread' then 'InThread:' || "thread_id"
      when "company_id" is null then 'NewThread:Personal'
      else 'NewThread:Company:' || "company_id" end) STORED,
	"text" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"saved_at" bigint NOT NULL,
	"device" text NOT NULL,
	CONSTRAINT "vivid_drafts_place_thread" CHECK (("place" = 'NewThread' and "thread_id" is null) or ("place" = 'InThread' and "thread_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_drafts_person_place" ON "vivid_drafts" ("person_id","place_key");--> statement-breakpoint
CREATE INDEX "vivid_drafts_workspace_saved" ON "vivid_drafts" ("person_id","company_id","saved_at");--> statement-breakpoint
ALTER TABLE "vivid_drafts" ADD CONSTRAINT "vivid_drafts_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_drafts" ADD CONSTRAINT "vivid_drafts_company_id_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_drafts" ADD CONSTRAINT "vivid_drafts_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE CASCADE;