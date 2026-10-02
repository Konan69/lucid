ALTER TABLE "vivid_routine_runs" ADD COLUMN "provider_event" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_routine_runs" ADD COLUMN "event_order" integer;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "integration" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "watch_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "event_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_routines" ADD COLUMN "pause" jsonb;