-- Flue runtime tables were orphaned by the move to one cell per Person; history was imported into the cells.
DROP TABLE IF EXISTS "flue_agent_submissions";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_attachments";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_conversation_fold_checkpoints";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_conversation_stream_batches";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_conversation_streams";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_meta";
--> statement-breakpoint
DROP TABLE IF EXISTS "flue_submission_chunks";
