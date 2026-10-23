ALTER TABLE "vivid_connections" ADD COLUMN "executor_app" text;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_connections_executor_app" ON "vivid_connections" ("executor_app");