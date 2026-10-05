CREATE TABLE "vivid_draft_generations" (
	"person_id" text PRIMARY KEY,
	"generation" bigint NOT NULL
);
--> statement-breakpoint
DROP INDEX "vivid_drafts_workspace_saved";--> statement-breakpoint
ALTER TABLE "vivid_drafts" ALTER COLUMN "revision" SET DATA TYPE bigint USING "revision"::bigint;--> statement-breakpoint
ALTER TABLE "vivid_drafts" ALTER COLUMN "revision" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "vivid_drafts_workspace_revision" ON "vivid_drafts" ("person_id","company_id","revision");--> statement-breakpoint
ALTER TABLE "vivid_draft_generations" ADD CONSTRAINT "vivid_draft_generations_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;