# Rich replies

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The real rehearsal reply contains an openui-lang program. The browser renders Rehearsal workload, the Project/Hours/Owner columns and Research/Writing/Review rows before and after reload.

## How to get to it (user POV)

Send show a table in a Thread.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature tool` after Launch and Doctor. Inspect `tool/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser tool`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Main renders inline OpenUI. The old show tool and Put it on screen button are gone. Other shipped scenes include charts, comparisons, forms, options, pictures and schedules; drive the scene touched by a change.
