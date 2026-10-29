ALTER TABLE `memory_entries` ADD `scope` text DEFAULT '{"_tag":"Personal"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD `citations` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Data, not schema: every entry written before citations existed cites the Run of its recorded
-- source, read from its stored authority; no message is invented for it.
UPDATE `memory_entries` SET `citations` = json_array(json_object('_tag', 'Run', 'source', json(json_extract(`authority`, '$.source'))));
