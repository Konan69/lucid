CREATE TABLE "vivid_machine_bindings" (
	"key" text PRIMARY KEY,
	"intent" text NOT NULL UNIQUE,
	"requested_at" bigint NOT NULL,
	"request" jsonb NOT NULL,
	"provider_id" text UNIQUE,
	"observed_state" text NOT NULL,
	"since" bigint NOT NULL
);
