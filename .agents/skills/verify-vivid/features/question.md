# Questions

Model requirement: real-model verification is blocked until the HTTP recipe supports model-generated questions. The existing fixed-label HTTP recipe is rehearsal-only and cannot produce a proved verdict. Browser controls have no recipe.

## Sub-features

A Waiting Input request contains one to four questions with single-choice, multiple-choice or written answers. AnswerInput stores the ordered answers. Delivery joins work already underway or starts a successor Decision Run. The fixed Research/Writing, Brief and Evidence and next steps answers belong only to the rehearsal recipe.

## How to get to it (user POV)

Ask Vivid for a structured question when it needs information. Answer each question above the composer, then submit the answers together. The phrase ask me produces the fixed three-question scene only in rehearsal.

## Driving it with verify-vivid

For a plumbing rehearsal only, launch with VIVID_VERIFY_MODEL=rehearsal/script and run `.agents/skills/verify-vivid/verify feature question` after Launch and Doctor. A real-model run records a blocked verdict and exits unsuccessfully with the rehearsal-only reason. Inspect `question/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser question`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The request now takes answers, an ordered tagged array, rather than answer, a string. Browser proof must visit every question and submit; HTTP proof alone does not prove those controls. Plain-text questions need no structured request. An ordinary message withdraws waiting questions. Selection, back navigation, written answers and withdrawal remain unproved.
