---
name: wide-research
description: |-
  When one lookup repeats across many independent inputs that all return the same fields.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/wide-research/SKILL.md`.
    Muse fans out to parallel workers; Vivid has none, so the same per-input lookup runs as bounded
    batches while the shared schema, single retry and coverage report stay.
---

Use this when one research task repeats across many independent inputs, such as one company, person or topic each, and every input returns the same fields. Do not use it for a single item or when one lookup depends on another's result; that is ordinary research.

Agree the operation in one sentence, the input list and the fields to return. Remove duplicates and normalise names before starting. Keep the fields minimal and explicit; avoid optional or free-form fields unless the Person asked for them. Use `ask_person` only if the list or the fields are unclear. Use `find_tools` to discover a connected search tool; if none is connected, offer `connect` and until then work only from addresses the Person supplied. Say at the start how many inputs will be checked.

Run the same lookup for every input, each scoped to its own item, with the same instructions and the same output shape. `run_code` can loop a batch through `use_tool` and `read_page` and return one normalised record per input; split a long list into batches that fit its limits, and never replay a batch that already completed. Record for each input either its fields with the source address, or a failure with its reason. Leave a field empty when the source does not state it; do not fill it from a neighbouring input or from assumption.

When completeness matters and some inputs failed, retry only the failed inputs, once. Then stop and report them as gaps.

Return one result set, with a table in a display in your reply when there are three or more rows. Always report coverage as successes out of the total, list the unresolved inputs and say why each failed. Reading needs no extra approval; contacting anyone on the list or changing external records needs the appropriate Approval.
