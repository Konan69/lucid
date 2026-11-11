---
name: wide-research
description: |-
  When one lookup repeats across many independent inputs that all return the same fields.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/wide-research/SKILL.md`.
    Muse fans out to parallel workers; Vivid does the same with helpers (`spawn_run`), at most four
    at work for one message, while the shared schema, single retry and coverage report stay.
---

Use this when one research task repeats across many independent inputs, such as one company, person or topic each, and every input returns the same fields. Do not use it for a single item or when one lookup depends on another's result; that is ordinary research.

Agree the operation in one sentence, the input list and the fields to return. Remove duplicates and normalise names before starting. Keep the fields minimal and explicit; avoid optional or free-form fields unless the Person asked for them. Use `ask_person` only if the list or the fields are unclear. Use `find_tools` to discover a connected search tool; if none is connected, offer `connect` and until then work only from addresses the Person supplied. Say at the start how many inputs will be checked.

Run the same lookup for every input, each scoped to its own item, with the same instructions and the same output shape. Start one Researcher helper per input with `spawn_run` (ReadOnly when the lookup needs files on your computer, Executor when it needs a connected search tool), at most four at a time; give each the identical brief with only its input changed, the exact fields to return and the source address to cite, because a helper sees nothing of this conversation. Their results come back to you as messages on their own: do not wait or poll, and start the next helpers as earlier ones finish. For a long list of quick lookups, give each helper a small group of inputs, or loop a batch through `use_tool` and `read_page` in one `run_code` program instead, and never replay a batch that already completed. Record for each input either its fields with the source address, or a failure with its reason. Leave a field empty when the source does not state it; do not fill it from a neighbouring input or from assumption.

When completeness matters and some inputs failed, retry only the failed inputs, once. Then stop and report them as gaps.

Return one result set, with a table in a display in your reply when there are three or more rows. Always say how many you found out of how many, name the ones you could not settle and why, in plain words ("no public page lists their pricing"). Reading needs no extra approval; contacting anyone on the list or changing external records needs the appropriate Approval.
