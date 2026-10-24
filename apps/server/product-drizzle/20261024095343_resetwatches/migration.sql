-- Display names cannot identify a Connection reliably. No existing Watch can be migrated safely.
-- Deleting these rows also removes their arrival receipts through the existing cascade.
DELETE FROM "vivid_watches";
