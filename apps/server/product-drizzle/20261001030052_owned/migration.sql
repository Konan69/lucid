ALTER TABLE "vivid_library_documents" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_library_folders" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_notifications" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_routines" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_tasks" ALTER COLUMN "person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_conversations" ALTER COLUMN "person_id" SET NOT NULL;