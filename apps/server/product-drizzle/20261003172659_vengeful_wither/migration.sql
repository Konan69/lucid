CREATE TABLE "vivid_devices" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"name" text NOT NULL,
	"access" text NOT NULL,
	"access_since" bigint NOT NULL,
	"enrolled_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "device_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "action" text NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "receipt" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "dispatched_at" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD COLUMN "status" text GENERATED ALWAYS AS (("receipt"->>'_tag')) STORED;--> statement-breakpoint
ALTER TABLE "vivid_device_requests" DROP COLUMN "request";--> statement-breakpoint
ALTER TABLE "vivid_device_requests" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_devices_installation" ON "vivid_devices" ("person_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_devices_allowed" ON "vivid_devices" ("person_id") WHERE "access" = 'Allowed';--> statement-breakpoint
ALTER TABLE "vivid_device_requests" ADD CONSTRAINT "vivid_device_requests_device_id_vivid_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "vivid_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_devices" ADD CONSTRAINT "vivid_devices_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;