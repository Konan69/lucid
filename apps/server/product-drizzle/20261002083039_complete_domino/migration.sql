DROP INDEX "vivid_approvals_signal";--> statement-breakpoint
CREATE INDEX "vivid_approvals_signal" ON "vivid_approvals" ("signal_due_at") WHERE "signal"->>'_tag' = 'Owed';--> statement-breakpoint
DROP INDEX "vivid_input_requests_signal";--> statement-breakpoint
CREATE INDEX "vivid_input_requests_signal" ON "vivid_input_requests" ("signal_due_at") WHERE "signal"->>'_tag' = 'Owed';