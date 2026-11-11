---
name: check-a-deliverable
description: |-
  When a document, page or data file is about to be handed over, or the Person asks for a check.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/artifacts/testing/SKILL.md`.
    Kept: look at what was rendered, scan for leftover scaffolding, stop after three failed fixes.
    Its per-format gate scripts have no Vivid tool and are not carried over.
---

A deliverable is checked by looking at what the Person will see, freshly, not by trusting the steps that produced it. Run this before saying that a document, page or data file is ready, and whenever the Person asks for a check. Never hand it over while a check below fails.

Check by kind. Read a document back with `read_document`. Open a page built on the Computer with `browse` and look at the rendered picture with `use_desktop`. For a data file on the Computer, parse it back with `bash` and compare its rows and columns with what was intended. A command that exits cleanly proves that it ran, not that its output is right.

Then look with fresh eyes, because whoever wrote it sees what was intended. Check first for cut-off or overflowing text, then overlaps, cramped or uneven spacing, text that is hard to read against its background, missing sections and decoration left from a template. Spot-check two or three figures against their sources instead of assuming a clean run made them correct.

Scan the text for leftover scaffolding: TODO, lorem, placeholder, insert-here brackets, runs of xxx and sample rows nobody asked for. Anything found is fixed, not handed over. Revise a document with `write_document`, then repeat the check from a fresh read instead of from memory.

After three failed attempts to fix the same problem, stop. Describe the specific failure and ask for direction with `ask_person` rather than iterating again. Tell them what you checked and anything you could not, in the terms of the deliverable ("i read it through and checked the totals against your sheet; i couldn't open the charts"), not the commands or tools you used; an unchecked part is named, never implied to be fine. Checking changes nothing outside the deliverable, and sending or publishing it still needs its own Approval.
