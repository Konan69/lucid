CREATE TABLE `memory_notes` (
	`layer` text NOT NULL,
	`file` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`body` text,
	`basis` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`authority` text NOT NULL,
	CONSTRAINT `memory_notes_pk` PRIMARY KEY(`layer`, `file`)
);
