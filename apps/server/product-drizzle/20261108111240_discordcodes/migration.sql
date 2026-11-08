CREATE TABLE "vivid_channel_codes" (
	"person_id" text,
	"channel" text,
	"code" text NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "vivid_channel_codes_pkey" PRIMARY KEY("person_id","channel")
);
--> statement-breakpoint
ALTER TABLE "vivid_channel_replies" ADD COLUMN "place" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_channel_codes_code" ON "vivid_channel_codes" ("channel","code");--> statement-breakpoint
ALTER TABLE "vivid_channel_codes" ADD CONSTRAINT "vivid_channel_codes_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;