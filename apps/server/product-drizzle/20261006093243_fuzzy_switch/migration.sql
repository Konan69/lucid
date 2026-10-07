ALTER TABLE "vivid_connections" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD COLUMN "identity" text;--> statement-breakpoint
ALTER TABLE "vivid_connections" ALTER COLUMN "label" DROP NOT NULL;