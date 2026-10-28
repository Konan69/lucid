-- User-approved FTS5 migration (Konan, 27 October 2026). The memory_entries table itself stays Drizzle-generated.
CREATE VIRTUAL TABLE memory_search USING fts5(
  file, description, body,
  content='memory_entries', content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER memory_search_insert AFTER INSERT ON memory_entries
WHEN new.body IS NOT NULL BEGIN
  INSERT INTO memory_search(rowid, file, description, body)
  VALUES (new.id, new.file, new.description, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER memory_search_update AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_search(memory_search, rowid, file, description, body)
  SELECT 'delete', old.id, old.file, old.description, old.body WHERE old.body IS NOT NULL;
  INSERT INTO memory_search(rowid, file, description, body)
  SELECT new.id, new.file, new.description, new.body WHERE new.body IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER memory_search_delete AFTER DELETE ON memory_entries
WHEN old.body IS NOT NULL BEGIN
  INSERT INTO memory_search(memory_search, rowid, file, description, body)
  VALUES ('delete', old.id, old.file, old.description, old.body);
END;
