CREATE TABLE "vivid_credentials" (
	"id" text PRIMARY KEY,
	"connector_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"scope" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vivid_credentials_connector" ON "vivid_credentials" ("connector_id");