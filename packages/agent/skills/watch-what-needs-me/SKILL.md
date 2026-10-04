---
name: watch-what-needs-me
description: |-
  On an authorised standing check, find urgent mail, overdue replies, calendar clashes and approaching deadlines, do small safe work, and notify only when the Person is needed.
metadata:
  provenance: |-
    Vivid's standing attention procedure follows the owner's product decision in docs/23-product-definition.md.
---

This check runs only after the Person switches on “Watch what needs me”. Do not create or enable it yourself without their request. The existing Routine supplies its schedule and private Thread; do not add another scheduler or quiet-hours, caps or digest settings.

Use `find_integrations` to see which mail and calendar accounts are actually connected, and `find_tools` to discover their read operations. Read recent urgent mail, messages whose promised reply is overdue, upcoming calendar events, clashes and approaching deadlines. Read what the Person has asked you to follow up from what you remember. Ground every finding in a real message, event or commitment and its timestamp. A failed read, an unavailable Integration or a missing promised date is not evidence of urgency. Do not invent a deadline or ask for an account connection on every check.

Judge what merits attention by consequence and what the Person has told you, not a generic summary. Ask whether the Person can do something about it now, whether it is new, and whether an earlier notification or Thread already covers it. Do not notify again about the same unchanged finding. Respect corrections the Person has given in words. Use `open_thread` for actionable work: give it one issue's verified evidence, source references and next step. Vivid continues and calls `notify_person` in that private Thread; do not also notify the same issue from this working Thread. Keep the verified finding in memory so another check can recognise it.

Act alone only on small reversible work within the existing trust loop. Preparing a draft, collecting evidence or organising a proposed next step is safe work. Sending messages, spending, deleting, publishing or doing anything irreversible still requires Approval through the existing tools. Do not widen access or bypass a rule because this is a background Run.

Call `notify_person` when an urgent message, an overdue reply they are owed, a calendar clash, a deadline or an awaited answer truly needs them. Use a short title and one or two lines with the concrete issue and next step. After small safe work, tell them the useful result when it merits attention. Do not expose another Person's private content or include credentials. The result proves only push-provider acceptance; never claim the Person saw it.

When nothing needs them, finish without a user-facing reply and without `notify_person`. Checking is work, not a reason to interrupt. Do not say “all clear”, narrate the check or produce a routine digest. Remember useful verified progress through the existing memory tools when needed to avoid repeating unchanged findings.
