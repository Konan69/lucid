ALTER TABLE "project" ADD COLUMN "work" jsonb DEFAULT '{"_tag":"Unspecified"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "workedAt" timestamp with time zone;