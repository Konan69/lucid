DROP TABLE memory_search;
--> statement-breakpoint
-- User-approved FTS5 migration, 27 October 2026. The ordinary memory_notes schema stays Drizzle-generated.
CREATE VIRTUAL TABLE memory_search USING fts5(
  file, description, body,
  content='memory_notes', content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER memory_search_insert AFTER INSERT ON memory_notes
WHEN new.body IS NOT NULL BEGIN
  INSERT INTO memory_search(rowid, file, description, body)
  VALUES (new.id, new.file, new.description, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER memory_search_update AFTER UPDATE ON memory_notes BEGIN
  INSERT INTO memory_search(memory_search, rowid, file, description, body)
  SELECT 'delete', old.id, old.file, old.description, old.body WHERE old.body IS NOT NULL;
  INSERT INTO memory_search(rowid, file, description, body)
  SELECT new.id, new.file, new.description, new.body WHERE new.body IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER memory_search_delete AFTER DELETE ON memory_notes
WHEN old.body IS NOT NULL BEGIN
  INSERT INTO memory_search(memory_search, rowid, file, description, body)
  VALUES ('delete', old.id, old.file, old.description, old.body);
END;
--> statement-breakpoint
INSERT INTO memory_search(rowid, file, description, body)
SELECT id, file, description, body FROM memory_notes WHERE body IS NOT NULL;
