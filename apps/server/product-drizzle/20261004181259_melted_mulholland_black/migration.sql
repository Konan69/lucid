CREATE TABLE "vivid_channel_links" (
	"person_id" text,
	"channel" text,
	"address" text NOT NULL,
	"text_to" text NOT NULL,
	"enrolment_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"thread_id" text,
	CONSTRAINT "vivid_channel_links_pkey" PRIMARY KEY("person_id","channel")
);
--> statement-breakpoint
CREATE TABLE "vivid_channel_messages" (
	"channel" text,
	"provider_id" text,
	"person_id" text,
	"received_at" bigint NOT NULL,
	CONSTRAINT "vivid_channel_messages_pkey" PRIMARY KEY("channel","provider_id")
);
--> statement-breakpoint
CREATE TABLE "vivid_channel_notices" (
	"channel" text,
	"address_hash" text,
	"day" text,
	CONSTRAINT "vivid_channel_notices_pkey" PRIMARY KEY("channel","address_hash","day")
);
--> statement-breakpoint
CREATE TABLE "vivid_channel_replies" (
	"run_id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vivid_channel_links_address" ON "vivid_channel_links" ("channel","address");--> statement-breakpoint
ALTER TABLE "vivid_channel_links" ADD CONSTRAINT "vivid_channel_links_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vivid_channel_links" ADD CONSTRAINT "vivid_channel_links_thread_id_vivid_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "vivid_conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vivid_channel_messages" ADD CONSTRAINT "vivid_channel_messages_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vivid_channel_replies" ADD CONSTRAINT "vivid_channel_replies_person_id_user_id_fkey" FOREIGN KEY ("person_id") REFERENCES "user"("id") ON DELETE CASCADE;