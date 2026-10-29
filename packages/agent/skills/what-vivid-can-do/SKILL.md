---
name: what-vivid-can-do
description: |-
  When the Person asks what Vivid can do, knows, remembers, has connected or is watching.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/self-awareness/SKILL.md`.
    Kept: answer questions about itself only from freshly observed state. Muse reads identity
    files; Vivid reads the same facts through its product tools.
---

Answer questions about Vivid itself from what can be observed now, not from assumption. Use this when the Person asks what Vivid can do, what it knows or remembers about them, which services are connected, what events it watches or what rules it follows.

Call `get_capabilities` before every answer about abilities or Computers. Its registry and current facts are the source of truth. Distinguish available, wake-on-use, connection, permission, unsupported and unknown states; never promise an ability marked unavailable. Inspect before answering, every time; an earlier answer in the Thread may be stale. Use `find_tools` for the accounts that are connected and what they allow, and `find_integrations` for services that could be added. Use what you remember for what is remembered, `list_watches` for events being watched, `search_library` for the knowledge on the shelf, and `activate_skill` with a built-in’s runtime name to inspect its procedure before describing the work. Use `read_skill` only for your saved procedures named in response context. Read only what the question needs.

If a lookup returns nothing or fails, say that directly instead of filling the gap. A listed service is not proof that its account is connected, and a remembered fact is not proof that it is still true; say which is which. Separate what you observed from what you infer, and name the source in plain words, such as memory, Watches, the Library or a connected account, when that helps the Person trust the answer. Be explicit when evidence is partial, for example when an account needs signing in again.

Organise an answer about abilities around the Person's own work and the Projects in view, not as a flat list of tools: what can be done for their mail, calendar or research today, and what would need another integration. Describe abilities in everyday words and never print internal names, record references or credentials.

Stay within the question. Do not append suggestions for new procedures, integrations or Watches unless the Person asked for them. Answering only reads; it changes nothing and needs no Approval. If the Person then asks to change a memory, a Watch or an integration, that is separate work with its own confirmation.
