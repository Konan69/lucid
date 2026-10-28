CREATE TABLE `memory_entries` (
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
	CONSTRAINT `memory_entries_address` UNIQUE(`layer`,`file`)
);
