CREATE TABLE "vivid_connection_permissions" (
	"connection_id" text,
	"data_class" text,
	"decision" text NOT NULL,
	CONSTRAINT "vivid_connection_permissions_pkey" PRIMARY KEY("connection_id","data_class")
);
--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD COLUMN "grant_observation" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_connection_permissions" ADD CONSTRAINT "vivid_connection_permissions_NwHVbmKUGHeI_fkey" FOREIGN KEY ("connection_id") REFERENCES "vivid_connections"("id") ON DELETE CASCADE;