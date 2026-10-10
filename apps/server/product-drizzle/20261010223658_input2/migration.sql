-- Convert every legacy question before generated DDL removes its old columns.
-- Keep owed signal text and all identity, status, and timestamp columns byte-for-byte.
UPDATE "vivid_input_requests"
SET "questions" = jsonb_build_array(jsonb_build_object(
  'question', "question",
  'options', "options",
  'selection', 'One',
  'allowsOwnAnswer', "allows_own_answer"
)),
"answers" = CASE
  WHEN "answer" IS NULL THEN NULL
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements("options") AS offered
    WHERE offered->>'label' = "answer"
  ) THEN jsonb_build_array(jsonb_build_object('_tag', 'Chosen', 'labels', jsonb_build_array("answer")))
  ELSE jsonb_build_array(jsonb_build_object('_tag', 'Written', 'words', "answer"))
END;
