---
name: forget-something
description: |-
  When the Person explicitly asks Vivid to stop remembering a fact, topic or past event.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/forget/SKILL.md`.
    Kept: a read-only plan, one explicit confirmation, cleanup through the owning tools and fresh
    verification. Its planner and executor workers and file staging are not carried over.
---

Treat forgetting as a cleanup across Vivid, not as removing one memory. Use it when the Person explicitly asks Vivid to stop remembering a fact, preference, relationship detail, topic or past event about them. It does not apply when the words only mean dropping the current task.

Make a plan first and change nothing. Look through what you remember, trying several wordings, to find every memory with the same meaning. Check `read_document` for documents in this Thread that contain it. Check `list_watches` for Watches whose instructions contain it. Note what is outside Vivid's reach: copies in connected services, items shared with the Company or other people, and another person's copy. Refer to that information rather than repeating it in the plan, a title or a new memory.

Show the plan in everyday words: memory, documents, Watches, shared items. State what will be removed, what cannot be undone and what will remain, then ask one direct confirmation with `ask_person`. Silence, an ambiguous reply, partial approval or a changed scope is not confirmation; make a revised plan instead of widening the cleanup.

After clear approval, check that the current state still matches the plan. Remove each matching memory, one at a time, and when several match let the Person choose. Revise a document with `write_document` so unrelated content is preserved. Stop a Watch that carries it with `stop_watching`, and if the Person still wants what it did, offer to watch again with an instruction that leaves it out. If a step fails, stop and explain; do not fall back to unplanned removal or claim success.

Verify from a fresh look at what you remember and a fresh read before reporting. Say which categories were cleaned up and what remains, without repeating the forgotten information. Say it is forgotten only when nothing in memory or Watches can bring it back. The request does not authorize deleting mail, calendar entries, shared items or anyone else's copy; each needs its own Approval.
