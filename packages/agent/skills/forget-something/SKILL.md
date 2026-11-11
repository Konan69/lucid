---
name: forget-something
description: |-
  When the Person explicitly asks Vivid to stop remembering a fact, topic or past event.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/forget/SKILL.md`.
    Kept: a read-only plan, confirmation when dependent memories or queued work are touched, cleanup through the owning tools and fresh
    verification. Its planner and executor workers and file staging are not carried over.
---

Treat forgetting as a cleanup across Vivid, not as removing one memory. Use it when the Person explicitly asks Vivid to stop remembering a fact, preference, relationship detail, topic or past event about them. It does not apply when the words only mean dropping the current task.

Make a plan first and change nothing. Look through what you remember, trying several wordings, to find every memory with the same meaning; read each one for its revision. Check `list_watches` for Watches whose instructions use it and the waiting-on list for records about it. Then call `plan_forget` with those entries (retract an ordinary entry; give a standing page back whole without that fact), those Watch names and those waiting-on records. Queued learning is stopped for you. Note what is outside Vivid's reach: copies in connected services, items shared with the Company or other people, and another person's copy. Refer to that information rather than repeating it in the plan, a title or a new memory.

If only the named fact will be removed, carry out the plan without asking. If dependent memories or queued work will also be cleared, show the plan in the words of their life, not the names of the parts that hold it: what you will stop remembering, what you will stop keeping an eye on for them, what you will stop waiting on, and what other people still have. State what will be removed, what cannot be undone and what will remain, then ask one direct confirmation with `ask_person`. Silence, an ambiguous reply, partial approval or a changed scope is not confirmation; make a revised plan instead of widening the cleanup. When the Person pressed Forget in Settings, that press is the confirmation: plan, then carry it out without asking.

Call `forget_memory` directly for the named fact alone, or after clear approval when dependent memories or queued work will also be cleared. It stops the Watches and waiting-on records, stops queued learning, retracts and rewrites the entries and reads everything back. If it says memory changed since the plan, read again and plan again; do not fall back to unplanned removal. If the Person still wants what a stopped Watch did, offer to watch again with an instruction that leaves it out. Revise a document of this Thread with `write_document` so unrelated content is preserved.

Report from its answer, in the same words of their life ("done. i've forgotten it, and i'll stop looking out for her emails"), without repeating the forgotten information. Say it is forgotten only when `forget_memory` answers completed; when it answers blocked, say what remains in everyday words. The request does not authorize deleting mail, calendar entries, shared items or anyone else's copy; each needs its own Approval.
