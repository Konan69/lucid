# Teaching a task

Model requirement: a real model with `EXPLABS_API_KEY` for the server memory/title model and a key for the chosen runtime model. Rehearsal cannot prove this feature and both recipes block in rehearsal mode.

## What it proves

A Person walks Vivid through a task once in a Thread and Vivid learns it as a procedure it reuses. The shipped guidance is `packages/agent/skills/learn-how-we-do-this/SKILL.md`; the readback boundary is `boundProcedure` in `packages/agent/runtime/src/tools/result.ts`. The Person never names, sees or manages the procedure.

Both recipes send a three-message walkthrough of filing a travel expense, asked in a Person's words with no tool, skill or field named. The second message carries a category table longer than 4,000 characters; the third corrects the code on its last row. The recipes check the actual receipts in every settled Run:

- `save_skill` succeeds exactly once (a save refused because the name is taken does not count), after the last message, and its instructions hold the corrected code.
- No Run calls `use_tool`, `watch`, `post`, `make_integration` or `notify_person`: learning a task does not do it or arrange it.
- Whether Vivid read the procedure back after saving is recorded in `taught.json` (`readBack`), not required: a model may skip that step. The whole-readback proof is the second Thread's `read_skill`.
- The public `ListSkills` holds one personal procedure for this walkthrough whose last table row is past 4,000 characters and keeps the correction. A model that shortens the table fails the recipe as a fixture failure, because the readback boundary was then not exercised.
- No visible reply says "skill" or "procedure".

A second Thread asks for the task with a new receipt for the corrected vendor. Its Run must read the procedure whole and reply with the corrected code, never the old one, and the amount.

## Drive with verify-vivid

```sh
.agents/skills/verify-vivid/verify feature procedure <run>
.agents/skills/verify-vivid/verify browser procedure <run>
```

The HTTP recipe uses the Person gateway and `WatchThread` settlement. The browser recipe sends every message through **Message Vivid** and **Send**, opens the second Thread at `/t/<id>`, waits for the corrected code in the page before and after reload, and checks that the page says nothing about skills. The HTTP recipe teaches a travel expense and the browser recipe a conference expense, each with its own vendor tag and codes: both run as one Person on a launch, and teaching the same task twice made Vivid revise the first procedure instead of learning a new one.

## Evidence

`procedure/` and `browser/procedure/` each hold `steps.json`, one directory per walkthrough message, `taught-history.json`, `skills.json`, `taught.json` (the saved procedure's name, scope, length and the corrected row's position), `applied-history.json`, `applied.json` and `scope.json`. Browser evidence adds `taught.png`, `applied.png` and `applied-reloaded.png`.

## Limits

Recording the Person's browser as a demonstration is not built (docs/23); this recipe proves only a walkthrough written in a Thread. Company procedures, procedure provenance and native clients are not driven.
