CREATE TABLE "vivid_push_deliveries" (
	"notification_id" text,
	"target_id" text,
	"body_hash" text NOT NULL,
	"body_length" integer NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "vivid_push_deliveries_pkey" PRIMARY KEY("notification_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "vivid_push_targets" (
	"id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"session_id" text NOT NULL,
	"address_hash" text NOT NULL,
	"destination" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_push_targets_address" ON "vivid_push_targets" ("address_hash");--> statement-breakpoint
CREATE INDEX "vivid_push_targets_person" ON "vivid_push_targets" ("person_id");--> statement-breakpoint
ALTER TABLE "vivid_push_deliveries" ADD CONSTRAINT "vivid_push_deliveries_qDO3qPAWlWxg_fkey" FOREIGN KEY ("notification_id") REFERENCES "vivid_notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_push_targets" ADD CONSTRAINT "vivid_push_targets_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_push_targets" ADD CONSTRAINT "vivid_push_targets_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;