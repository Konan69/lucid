-- Data only; no schema changes.
--
-- A Task reports to a Thread and is only ever found through it. Deleting a Thread used to leave
-- its Tasks behind where nobody could see them, with follow-ups still firing at a Thread that no
-- longer existed. The next migration ties a Task to its Thread, so the ones already left behind
-- are removed here, exactly as deleting the Thread will remove them from now on.
DELETE FROM vivid_tasks AS task
WHERE NOT EXISTS (
  SELECT 1 FROM vivid_conversations AS thread WHERE thread.id = task.conversation_id
);
