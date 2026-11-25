CREATE TABLE "runtime"."imported_submissions" (
	"person_id" text,
	"flue_submission_id" text,
	"submission_id" text NOT NULL,
	CONSTRAINT "imported_submissions_pkey" PRIMARY KEY("person_id","flue_submission_id")
);
