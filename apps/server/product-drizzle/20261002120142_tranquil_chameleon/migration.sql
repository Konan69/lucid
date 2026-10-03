ALTER TABLE "vivid_skills" ADD COLUMN "about" text;
--> statement-breakpoint
UPDATE "vivid_skills" SET "about" = "use_when";
