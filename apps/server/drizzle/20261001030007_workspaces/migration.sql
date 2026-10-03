ALTER TABLE "settings" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "notify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "companyId" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "project_creator_idx" ON "project" ("createdBy");--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_createdBy_user_id_fkey", ADD CONSTRAINT "project_createdBy_user_id_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE CASCADE;