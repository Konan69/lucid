CREATE TABLE "vivid_executor_members" (
	"person_id" text PRIMARY KEY,
	"email" text NOT NULL UNIQUE,
	"state" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD COLUMN "executor_principal" text DEFAULT 'installation' NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_executor_members" ADD CONSTRAINT "vivid_executor_members_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;