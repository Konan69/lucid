# Rich replies

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The HTTP check parses assistant-only openui-lang fences with the shipped parser and library schema (`packages/agent/runtime/src/agents/parts.json`), evaluates each at its `$state` defaults as a client first draws it, and asserts one Table with three exact columns and nine text or number cells. Rows the display computes (an `@Each` over a filtered list) count as drawn. User prompts, prose and missing tables fail. The browser checks the Project/Hours/Owner columns and the complete Research/4/Ada, Writing/3/Ben and Review/2/Cai rows before and after reload. The title is model-generated and is not the rendering assertion.

## How to get to it (user POV)

Send show a table in a Thread.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature tool` after Launch and Doctor. Inspect `tool/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser tool`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Main renders inline OpenUI. The old show tool and Put it on screen button are gone. Other shipped scenes include charts, comparisons, forms, options, pictures and schedules; drive the scene touched by a change.
