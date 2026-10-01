-- Data only; no schema changes.
--
-- Records made before Vivid had accounts have no owner. The earliest Person adopts them: on an
-- installation that had exactly one user, that is the user. The next migration makes the owner
-- required, so this one refuses to continue when ownerless records exist and nobody has signed up
-- yet, rather than deleting work nobody asked to delete. Sign up, then migrate again.
DO $$
DECLARE
  adopter text;
  ownerless bigint;
BEGIN
  SELECT id INTO adopter FROM "user" ORDER BY "createdAt", id LIMIT 1;

  SELECT
    (SELECT count(*) FROM vivid_conversations WHERE person_id IS NULL) +
    (SELECT count(*) FROM vivid_tasks WHERE person_id IS NULL) +
    (SELECT count(*) FROM vivid_notifications WHERE person_id IS NULL) +
    (SELECT count(*) FROM vivid_routines WHERE person_id IS NULL) +
    (SELECT count(*) FROM vivid_library_folders WHERE person_id IS NULL) +
    (SELECT count(*) FROM vivid_library_documents WHERE person_id IS NULL)
  INTO ownerless;

  IF ownerless > 0 AND adopter IS NULL THEN
    RAISE EXCEPTION
      '% records predate accounts and no Person exists to own them. Create an account, then run the migrations again.',
      ownerless;
  END IF;

  UPDATE vivid_conversations SET person_id = adopter WHERE person_id IS NULL;
  UPDATE vivid_tasks SET person_id = adopter WHERE person_id IS NULL;
  UPDATE vivid_notifications SET person_id = adopter WHERE person_id IS NULL;
  UPDATE vivid_routines SET person_id = adopter WHERE person_id IS NULL;
  UPDATE vivid_library_folders SET person_id = adopter WHERE person_id IS NULL;
  UPDATE vivid_library_documents SET person_id = adopter WHERE person_id IS NULL;
END $$;
