ALTER TABLE `memory_notes` ADD `id` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`layer` text NOT NULL,
	`file` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`body` text,
	`basis` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`authority` text NOT NULL,
	CONSTRAINT `memory_notes_address` UNIQUE(`layer`,`file`)
);
--> statement-breakpoint
INSERT INTO `__new_memory_notes`(`layer`, `file`, `kind`, `description`, `body`, `basis`, `revision`, `updated_at`, `authority`) SELECT `layer`, `file`, `kind`, `description`, `body`, `basis`, `revision`, `updated_at`, `authority` FROM `memory_notes`;--> statement-breakpoint
DROP TABLE `memory_notes`;--> statement-breakpoint
ALTER TABLE `__new_memory_notes` RENAME TO `memory_notes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;