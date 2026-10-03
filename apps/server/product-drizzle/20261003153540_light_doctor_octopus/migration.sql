ALTER TABLE "vivid_follow_ups" DROP CONSTRAINT "vivid_follow_ups_task_id_vivid_tasks_id_fkey";--> statement-breakpoint
DROP TABLE "vivid_follow_ups";--> statement-breakpoint
DROP TABLE "vivid_tasks";--> statement-breakpoint
ALTER TABLE "vivid_notifications" DROP COLUMN "task_id";--> statement-breakpoint
-- Scheduled reminders retain their historical Run, Person and Thread under Routine attribution.
UPDATE "vivid_runs"
SET "origin" = jsonb_build_object('_tag', 'Routine', 'routineName', "origin"->>'taskTitle')
WHERE "origin"->>'_tag' = 'FollowUp';--> statement-breakpoint
-- Retired notification kinds cannot be decoded by the remaining recipient feed.
DELETE FROM "vivid_notifications"
WHERE "kind" IN ('tracked', 'overdue', 'follow-up', 'follow-up-failed', 'assigned');
