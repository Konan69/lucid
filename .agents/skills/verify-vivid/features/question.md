# Questions

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

A Waiting Input request contains Several, One and free-text questions. A Person chooses Research and Writing, Brief, and writes Evidence and next steps. AnswerInput stores all answers and a Decision Run settles.

## How to get to it (user POV)

Send ask me. Answer the three questions together.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature question` after Launch and Doctor. Inspect `question/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser question`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The request now takes answers, an ordered tagged array, rather than answer, a string. Browser proof must visit all three questions and submit; HTTP proof alone does not prove the multi-question controls.
