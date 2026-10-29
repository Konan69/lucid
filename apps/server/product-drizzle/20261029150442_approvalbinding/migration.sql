ALTER TABLE "vivid_approvals" ADD COLUMN "binding" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_approvals" ADD COLUMN "invalidation" jsonb;--> statement-breakpoint
ALTER TABLE "vivid_connections" ADD COLUMN "authorization_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A pending Approval raised before bindings existed says nothing about the document or the
-- Integration sign-in it was asked against, so Allow could run it against whatever is there now.
-- It is closed as Superseded rather than given an invented binding; Vivid asks again when needed.
UPDATE "vivid_approvals" SET "status" = 'invalidated', "finished_at" = (extract(epoch from now()) * 1000)::bigint, "invalidation" = '{"_tag":"Superseded"}'::jsonb WHERE "status" = 'pending';
