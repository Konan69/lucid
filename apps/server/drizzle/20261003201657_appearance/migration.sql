ALTER TABLE "company" ADD COLUMN "vividName" text DEFAULT 'Vivid' NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "vividLook" jsonb DEFAULT '{"_tag":"Accent"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vividName" text DEFAULT 'Vivid' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "vividLook" jsonb DEFAULT '{"_tag":"Accent"}' NOT NULL;